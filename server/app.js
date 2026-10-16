'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { HttpError, sendJson, readBody, parseCookies, serializeCookie, parseMultipart, createLimiter, Router, serveFile } = require('./lib/web');
const auth = require('./auth');
const catalog = require('./catalog');
const orders = require('./orders');
const razorpay = require('./razorpay');
const { inspectJpeg } = require('./jpeg');
const { seedIfNeeded } = require('./db');

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://lumberjack-metrics.razorpay.com",
  'frame-src https://api.razorpay.com https://checkout.razorpay.com',
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

function setSecurityHeaders(res, cfg) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com" "https://api.razorpay.com")');
  if (cfg.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function clientIp(req, cfg) {
  if (cfg.trustProxy && cfg.clientIpHeader) {
    const value = String(req.headers[cfg.clientIpHeader] || '').split(',')[0].trim();
    if (value) return value;
  }
  if (cfg.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean);
    // The last entry is the one our own reverse proxy added; earlier ones can be forged by the client.
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return req.socket.remoteAddress || '';
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Blocked cross-site request.'); }
    if (host !== req.headers.host) throw new HttpError(403, 'Blocked cross-site request.');
  } else if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Blocked cross-site request.');
  }
}

const publicOrder = order => ({ number: order.number, subtotal: order.subtotal, shipping: order.shipping, total: order.total, method: order.method });

function registerRoutes(r, { cfg, db, limits }) {
  const uploadsDir = path.join(cfg.dataDir, 'uploads');

  // ---------- public ----------
  r.get('/api/config', c => {
    c.headers['Cache-Control'] = 'no-cache';
    return {
      storeName: cfg.storeName,
      whatsapp: cfg.whatsapp,
      onlinePayments: cfg.onlinePayments,
      razorpayKeyId: cfg.onlinePayments ? cfg.razorpay.keyId : '',
      cod: cfg.codEnabled,
      shippingFee: cfg.shippingFee,
      freeShippingAbove: cfg.freeShippingAbove
    };
  });

  r.get('/api/products', c => {
    c.headers['Cache-Control'] = 'no-cache';
    return catalog.listProducts(db);
  });

  r.post('/api/orders', async c => {
    if (!limits.order.take(c.ip)) throw new HttpError(429, 'Too many orders from this device. Please try again later.');
    const order = orders.createOrder(cfg, db, c.body);
    c.status = 201;
    if (order.method === 'cod') {
      console.log(JSON.stringify({ event: 'order.created', number: order.number, method: 'cod', total: order.total }));
      return { order: publicOrder(order) };
    }
    try {
      const created = await razorpay.createRazorpayOrder(cfg, { amountPaise: order.total * 100, receipt: order.number, notes: { order: order.number } });
      orders.attachRazorpayOrder(db, order.id, created.id);
      console.log(JSON.stringify({ event: 'order.created', number: order.number, method: 'online', total: order.total }));
      return {
        order: publicOrder(order),
        razorpay: {
          keyId: cfg.razorpay.keyId,
          orderId: created.id,
          amount: order.total * 100,
          currency: 'INR',
          name: cfg.storeName,
          description: `Order ${order.number}`,
          prefill: { name: order.name, contact: `+${order.phone}`, email: order.email }
        }
      };
    } catch (error) {
      orders.discardOrder(db, order.id);
      console.error(JSON.stringify({ event: 'razorpay.order_failed', message: error.message }));
      throw new HttpError(502, 'We could not start the payment. Please try again, or choose cash on delivery.');
    }
  });

  r.post('/api/orders/:number/verify', c => {
    if (!limits.verify.take(c.ip)) throw new HttpError(429, 'Too many attempts. Please wait a while.');
    const order = orders.findByNumber(db, c.params.number);
    if (!order || order.payment_method !== 'online' || !order.razorpay_order_id) throw new HttpError(404, 'Order not found.');
    const body = c.body || {};
    const valid = body.razorpay_order_id === order.razorpay_order_id && razorpay.verifyPaymentSignature(cfg, {
      orderId: body.razorpay_order_id, paymentId: body.razorpay_payment_id, signature: body.razorpay_signature
    });
    if (!valid) throw new HttpError(400, 'We could not confirm this payment. If money was deducted, it will be matched to your order automatically; you can also message us on WhatsApp with your order number.');
    const result = orders.markPaid(db, order, { paymentId: String(body.razorpay_payment_id), source: 'checkout', event: 'payment.verified' });
    if (result.changed) console.log(JSON.stringify({ event: 'order.paid', number: order.number, source: 'checkout' }));
    return { order: { number: order.number, total: order.total, subtotal: order.subtotal, shipping: order.shipping, method: 'online' }, paid: true };
  });

  r.post('/api/webhooks/razorpay', c => {
    if (!cfg.razorpay.webhookSecret) throw new HttpError(503, 'Webhook is not configured.');
    const raw = c.rawBody.toString('utf8');
    if (!razorpay.verifyWebhookSignature(cfg, raw, c.req.headers['x-razorpay-signature'])) throw new HttpError(400, 'Invalid signature.');
    let event;
    try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid payload.'); }
    const payment = event && event.payload && event.payload.payment && event.payload.payment.entity;
    const razorpayOrderId = payment ? payment.order_id : (event && event.payload && event.payload.order && event.payload.order.entity && event.payload.order.entity.id);
    if (!razorpayOrderId) return { ok: true, ignored: true };
    const order = orders.findByRazorpayOrder(db, razorpayOrderId);
    if (!order) return { ok: true, ignored: true };
    if ((event.event === 'payment.captured' || event.event === 'order.paid') && payment && payment.status !== 'failed') {
      if (Number(payment.amount) !== order.total * 100) {
        console.error(JSON.stringify({ event: 'webhook.amount_mismatch', number: order.number, got: payment.amount, expected: order.total * 100 }));
        return { ok: true, ignored: true };
      }
      const result = orders.markPaid(db, order, { paymentId: payment.id, source: 'webhook', event: event.event });
      if (result.changed) console.log(JSON.stringify({ event: 'order.paid', number: order.number, source: 'webhook' }));
    } else if (event.event === 'payment.failed') {
      console.log(JSON.stringify({ event: 'payment.failed', number: order.number }));
    }
    return { ok: true };
  }, { body: 'raw' });

  // ---------- owner sign-in ----------
  r.post('/api/auth/login', async c => {
    const email = String(c.body.email || '').trim().toLowerCase().slice(0, 200);
    if (!limits.login.take(`ip:${c.ip}`) || !limits.login.take(`email:${email}`)) throw new HttpError(429, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
    const admin = await auth.authenticate(db, email, c.body.password);
    if (!admin) throw new HttpError(401, 'That email or password is not correct.');
    limits.login.reset(`ip:${c.ip}`);
    limits.login.reset(`email:${email}`);
    const session = auth.createSession(db, cfg, admin.id);
    c.setCookies.push(serializeCookie(auth.COOKIE_NAME, session.token, { maxAge: session.maxAge, secure: cfg.secureCookies }));
    return { admin: { email: admin.email } };
  });

  r.post('/api/auth/logout', c => {
    auth.destroySession(db, c.cookies[auth.COOKIE_NAME]);
    c.setCookies.push(serializeCookie(auth.COOKIE_NAME, '', { maxAge: 0, secure: cfg.secureCookies }));
    return { ok: true };
  });

  r.get('/api/auth/me', c => ({ admin: auth.adminFromToken(db, c.cookies[auth.COOKIE_NAME]) && { email: auth.adminFromToken(db, c.cookies[auth.COOKIE_NAME]).email } }));

  // ---------- owner area ----------
  const admin = { admin: true };

  r.post('/api/admin/password', async c => {
    const problem = auth.checkPasswordStrength(c.body.next);
    if (problem) throw new HttpError(400, problem);
    const verified = await auth.authenticate(db, c.admin.email, c.body.current);
    if (!verified) throw new HttpError(400, 'Your current password is not correct.');
    const hash = await auth.hashPassword(c.body.next);
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, c.admin.id);
    db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash != ?').run(c.admin.id, auth.sha256(c.cookies[auth.COOKIE_NAME]));
    return { ok: true };
  }, admin);

  r.get('/api/admin/products', () => catalog.listProducts(db), admin);
  r.post('/api/admin/products', c => { c.status = 201; return catalog.createProduct(cfg, db, c.body); }, admin);
  r.put('/api/admin/products/:id', c => catalog.updateProduct(cfg, db, c.params.id, c.body), admin);
  r.patch('/api/admin/products/:id/stock', c => catalog.setStock(db, c.params.id, c.body.inStock !== false), admin);
  r.delete('/api/admin/products/:id', c => { catalog.deleteProduct(cfg, db, c.params.id); return { ok: true }; }, admin);

  r.post('/api/admin/uploads', c => {
    const full = c.parts.find(part => part.name === 'full' && part.filename !== null);
    const thumb = c.parts.find(part => part.name === 'thumb' && part.filename !== null);
    if (!full || !thumb) throw new HttpError(400, 'Choose a photo to upload.');
    const fullInfo = inspectJpeg(full.data);
    const thumbInfo = inspectJpeg(thumb.data);
    if (!fullInfo || !thumbInfo) throw new HttpError(400, 'That file is not a valid photo. Use a JPEG, PNG or WebP image.');
    if (Math.max(fullInfo.width, fullInfo.height) > 4000 || Math.max(thumbInfo.width, thumbInfo.height) > 1000) throw new HttpError(400, 'That photo is too large.');
    if (full.data.length > 6_000_000 || thumb.data.length > 800_000) throw new HttpError(400, 'That photo file is too large.');
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(uploadsDir, `${id}.jpg`), full.data);
    fs.writeFileSync(path.join(uploadsDir, `${id}-t.jpg`), thumb.data);
    c.status = 201;
    return { url: `/uploads/${id}.jpg`, thumbUrl: `/uploads/${id}-t.jpg` };
  }, { admin: true, body: 'multipart' });

  r.get('/api/admin/orders', c => ({ orders: orders.listOrders(db, { status: String(c.query.status || '') }) }), admin);
  r.patch('/api/admin/orders/:id', c => ({ order: orders.updateOrder(db, Number(c.params.id), c.body || {}) }), admin);
}

function createApp(cfg, db) {
  seedIfNeeded(db, cfg);
  const router = new Router();
  const limits = {
    login: createLimiter({ max: 8, windowMs: 15 * 60_000 }),
    order: createLimiter({ max: 20, windowMs: 60 * 60_000 }),
    verify: createLimiter({ max: 60, windowMs: 60 * 60_000 })
  };
  registerRoutes(router, { cfg, db, limits });

  const publicRoot = path.resolve(cfg.publicDir);
  const uploadsRoot = path.resolve(cfg.dataDir, 'uploads');

  async function handleApi(req, res, url) {
    const { route, params, pathMatched } = router.match(req.method, url.pathname);
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed.' : 'Not found.');
    const unsafe = req.method !== 'GET' && req.method !== 'HEAD';
    if (unsafe) checkOrigin(req);
    const c = {
      req, res, url, params, cfg, db, ip: clientIp(req, cfg), query: Object.fromEntries(url.searchParams),
      cookies: parseCookies(req.headers.cookie), status: 200, headers: { 'Cache-Control': 'no-store' }, setCookies: [],
      body: null, rawBody: null, parts: null, admin: null
    };
    if (route.options.admin) {
      c.admin = auth.adminFromToken(db, c.cookies[auth.COOKIE_NAME]);
      if (!c.admin) throw new HttpError(401, 'Please sign in.');
    }
    const mode = route.options.body || (unsafe ? 'json' : 'none');
    const contentType = String(req.headers['content-type'] || '');
    if (mode === 'json') {
      const buffer = await readBody(req, 100_000);
      if (buffer.length) {
        // Browsers cannot send application/json across sites without a CORS preflight, so requiring it blocks cross-site form posts.
        if (!/^application\/json/i.test(contentType)) throw new HttpError(415, 'Unsupported request type.');
        try { c.body = JSON.parse(buffer.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
        if (c.body === null || typeof c.body !== 'object') throw new HttpError(400, 'Invalid JSON.');
      } else {
        c.body = {};
      }
    } else if (mode === 'raw') {
      c.rawBody = await readBody(req, 1_000_000);
    } else if (mode === 'multipart') {
      if (!/^multipart\/form-data/i.test(contentType)) throw new HttpError(415, 'Unsupported request type.');
      c.parts = parseMultipart(await readBody(req, 8_000_000), contentType, { maxParts: 4 });
    }
    const result = await route.handler(c);
    const headers = { ...c.headers };
    if (c.setCookies.length) headers['Set-Cookie'] = c.setCookies;
    sendJson(res, c.status, result === undefined ? { ok: true } : result, headers);
  }

  function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    let served = false;
    if (pathname.startsWith('/uploads/')) {
      served = serveFile(req, res, uploadsRoot, pathname.slice('/uploads/'.length), { cache: 'public, max-age=31536000, immutable' });
    } else {
      let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (relative === 'admin') relative = 'admin.html';
      if (relative === 'order' || relative === 'checkout') relative = 'order.html';
      served = serveFile(req, res, publicRoot, relative, { cache: 'no-cache' });
    }
    if (!served) {
      const body = '<!doctype html><meta charset="utf-8"><title>Page not found</title><p style="font:16px sans-serif;padding:40px">Page not found. <a href="/">Back to the shop</a></p>';
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      setSecurityHeaders(res, cfg);
      if (url.pathname === '/healthz') {
        db.prepare('SELECT 1').get();
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else handleStatic(req, res, url.pathname);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...(error.extra || {}) }, { 'Cache-Control': 'no-store' });
      console.error(JSON.stringify({ event: 'error', message: error && error.message, stack: error && error.stack }));
      sendJson(res, 500, { error: 'Something went wrong. Please try again.' }, { 'Cache-Control': 'no-store' });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;

  return {
    server,
    close() {
      Object.values(limits).forEach(limiter => limiter.stop());
      return new Promise(resolve => server.close(() => resolve()));
    }
  };
}

module.exports = { createApp };
