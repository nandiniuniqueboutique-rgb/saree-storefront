'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { loadConfig } = require('../config');
const { openDb } = require('../db');
const { createApp } = require('../app');
const { createAdmin } = require('../auth');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name));

/** A stand-in for api.razorpay.com so tests never need real keys. */
function startMockRazorpay() {
  const state = { orders: [], fail: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method !== 'POST' || req.url !== '/v1/orders') return send(404, {});
      const expected = `Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`;
      if (req.headers.authorization !== expected) return send(401, { error: { description: 'Authentication failed' } });
      if (state.fail) return send(500, { error: { description: 'Gateway down' } });
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const order = { id: `order_TEST${state.orders.length + 1}`, amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created' };
      state.orders.push({ ...order, notes: body.notes });
      send(200, order);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

async function startTestServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nandini-test-'));
  const razorpayMock = await startMockRazorpay();
  const cfg = loadConfig({
    DATA_DIR: dataDir,
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: 'whsec_test',
    RAZORPAY_API_BASE: razorpayMock.url,
    SHIPPING_FEE: '60',
    FREE_SHIPPING_ABOVE: '5000',
    COD_ENABLED: 'true', // production default is off; most order tests exercise both payment methods
    ...extraEnv
  });
  const db = openDb(dataDir);
  await createAdmin(db, 'owner@example.com', 'correct horse battery');
  const app = createApp(cfg, db);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const api = {
    base, cfg, db, dataDir, razorpay: razorpayMock.state,
    async request(method, urlPath, { json, body, headers = {}, cookie } = {}) {
      const init = { method, headers: { ...headers }, redirect: 'manual' };
      if (json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
      if (body !== undefined) init.body = body;
      if (cookie) init.headers.Cookie = cookie;
      const response = await fetch(base + urlPath, init);
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, headers: response.headers, data, text };
    },
    async login(email = 'owner@example.com', password = 'correct horse battery') {
      const response = await api.request('POST', '/api/auth/login', { json: { email, password } });
      const cookie = (response.headers.getSetCookie()[0] || '').split(';')[0];
      return { response, cookie };
    },
    async upload(cookie, a = 'photo.jpg', b = 'thumb.jpg') {
      const form = new FormData();
      form.append('full', new Blob([fixture(a)], { type: 'image/jpeg' }), 'photo.jpg');
      form.append('thumb', new Blob([fixture(b)], { type: 'image/jpeg' }), 'thumb.jpg');
      return api.request('POST', '/api/admin/uploads', { body: form, cookie });
    },
    async close() {
      await app.close();
      db.close();
      await new Promise(resolve => razorpayMock.server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
  return api;
}

const customer = { name: 'Asha Rao', phone: '98765 43210', email: 'asha@example.com', address: '12 MG Road, Indiranagar', city: 'Bengaluru 560038' };

const signCheckout = (orderId, paymentId, secret = 'rzp_test_secret') => crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
const signWebhook = (raw, secret = 'whsec_test') => crypto.createHmac('sha256', secret).update(raw).digest('hex');

module.exports = { startTestServer, fixture, customer, signCheckout, signWebhook };
