'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer, customer, signCheckout, signWebhook } = require('./helpers');

let t;
let cookie;

before(async () => {
  t = await startTestServer();
  cookie = (await t.login()).cookie;
});
after(async () => { await t.close(); });

const productBody = (images, extra = {}) => ({
  name: 'Floral Anarkali Dress', detail: 'Cotton blend', description: 'Soft cotton.\nMachine wash cold.', type: 'Dress', category: 'party wear',
  price: 1499, originalPrice: 1799, tag: '', alt: '', inStock: true, images, ...extra
});

async function newProduct(extra = {}) {
  const upload = await t.upload(cookie);
  assert.equal(upload.status, 201);
  const created = await t.request('POST', '/api/admin/products', { json: productBody([upload.data], extra), cookie });
  assert.equal(created.status, 201, created.text);
  return created.data;
}

test('serves health and security headers', async () => {
  const health = await t.request('GET', '/healthz');
  assert.equal(health.status, 200);
  const page = await t.request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/checkout\.razorpay\.com/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

test('first start loads the sample catalog', async () => {
  const response = await t.request('GET', '/api/products');
  assert.equal(response.status, 200);
  assert.equal(response.data.length, 5);
  const first = response.data[0];
  assert.ok(first.name && first.price > 0 && first.image && Array.isArray(first.images) && first.inStock === true);
});

test('config exposes only public settings', async () => {
  const response = await t.request('GET', '/api/config');
  assert.equal(response.data.onlinePayments, true);
  assert.equal(response.data.razorpayKeyId, 'rzp_test_key');
  assert.ok(!JSON.stringify(response.data).includes('rzp_test_secret'));
  assert.ok(!JSON.stringify(response.data).includes('whsec_test'));
});

test('owner area needs a session', async () => {
  for (const [method, url] of [['GET', '/api/admin/products'], ['GET', '/api/admin/orders'], ['POST', '/api/admin/products'], ['DELETE', '/api/admin/products/x'], ['PATCH', '/api/admin/orders/1']]) {
    const response = await t.request(method, url, method === 'GET' || method === 'DELETE' ? {} : { json: {} });
    assert.equal(response.status, 401, `${method} ${url}`);
  }
  const upload = await t.upload('');
  assert.equal(upload.status, 401);
});

test('login: wrong password fails, right one sets a locked-down cookie', async () => {
  const bad = await t.request('POST', '/api/auth/login', { json: { email: 'owner@example.com', password: 'nope-nope-nope' } });
  assert.equal(bad.status, 401);
  const unknown = await t.request('POST', '/api/auth/login', { json: { email: 'someone@else.com', password: 'nope-nope-nope' } });
  assert.equal(unknown.status, 401);
  assert.equal(bad.data.error, unknown.data.error, 'same message for unknown email and wrong password');
  const { response } = await t.login();
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie()[0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const me = await t.request('GET', '/api/auth/me', { cookie });
  assert.equal(me.data.admin.email, 'owner@example.com');
  const anonymous = await t.request('GET', '/api/auth/me');
  assert.equal(anonymous.data.admin, null);
});

test('login is rate limited', async () => {
  const other = await startTestServer();
  try {
    let last;
    for (let i = 0; i < 10; i += 1) last = await other.request('POST', '/api/auth/login', { json: { email: 'owner@example.com', password: `wrong-password-${i}` } });
    assert.equal(last.status, 429);
    const right = await other.request('POST', '/api/auth/login', { json: { email: 'owner@example.com', password: 'correct horse battery' } });
    assert.equal(right.status, 429, 'even the right password is refused while locked out');
  } finally { await other.close(); }
});

test('cross-site and wrongly typed requests are refused', async () => {
  const cross = await t.request('POST', '/api/orders', { json: {}, headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const siteHeader = await t.request('POST', '/api/orders', { json: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(siteHeader.status, 403);
  const form = await t.request('POST', '/api/orders', { body: 'a=b', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(form.status, 415);
  const garbage = await t.request('POST', '/api/orders', { body: '{nope', headers: { 'Content-Type': 'application/json' } });
  assert.equal(garbage.status, 400);
});

test('photo upload accepts real JPEGs only and serves them with long caching', async () => {
  const form = new FormData();
  form.append('full', new Blob(['<script>alert(1)</script>'.repeat(20)], { type: 'image/jpeg' }), 'x.jpg');
  form.append('thumb', new Blob(['not an image'.repeat(20)], { type: 'image/jpeg' }), 'y.jpg');
  const bad = await t.request('POST', '/api/admin/uploads', { body: form, cookie });
  assert.equal(bad.status, 400);

  const good = await t.upload(cookie);
  assert.equal(good.status, 201);
  assert.match(good.data.url, /^\/uploads\/[0-9a-f]{32}\.jpg$/);
  const served = await fetch(t.base + good.data.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.match(served.headers.get('cache-control'), /immutable/);
  assert.equal((await served.arrayBuffer()).byteLength, fs.statSync(path.join(t.dataDir, 'uploads', path.basename(good.data.url))).size);
});

test('product lifecycle: create, edit, mark sold out, delete (files are cleaned up)', async () => {
  const created = await newProduct();
  assert.equal(created.category, 'Party wear');
  assert.equal(created.type, 'Dress');
  assert.equal(created.tag, 'New arrival');
  assert.equal(created.alt, 'Floral Anarkali Dress');
  const list = await t.request('GET', '/api/products');
  assert.equal(list.data[0].id, created.id, 'new products appear first');

  const second = await t.upload(cookie, 'photo2.jpg', 'thumb2.jpg');
  const updated = await t.request('PUT', `/api/admin/products/${created.id}`, {
    json: productBody([second.data, created.photos[0]], { name: 'Floral Anarkali Dress v2', description: 'Updated text' }), cookie
  });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.data.photos.length, 2);
  assert.equal(updated.data.image, second.data.url, 'first photo is the cover');

  const dropped = await t.request('PUT', `/api/admin/products/${created.id}`, { json: productBody([second.data], { name: 'Floral Anarkali Dress v2' }), cookie });
  assert.equal(dropped.data.photos.length, 1);
  assert.ok(!fs.existsSync(path.join(t.dataDir, 'uploads', path.basename(created.photos[0].url))), 'removed photo file deleted');

  const stock = await t.request('PATCH', `/api/admin/products/${created.id}/stock`, { json: { inStock: false }, cookie });
  assert.equal(stock.data.inStock, false);

  const removed = await t.request('DELETE', `/api/admin/products/${created.id}`, { cookie });
  assert.equal(removed.status, 200);
  assert.ok(!fs.existsSync(path.join(t.dataDir, 'uploads', path.basename(second.data.url))), 'photo file deleted with the product');
  assert.equal((await t.request('GET', '/api/products')).data.find(p => p.id === created.id), undefined);
});

test('product validation', async () => {
  const upload = await t.upload(cookie);
  const attempts = [
    [productBody([upload.data], { name: '' }), /Product name/],
    [productBody([upload.data], { price: 0 }), /price/],
    [productBody([upload.data], { price: 'abc' }), /price/],
    [productBody([upload.data], { originalPrice: 100 }), /original price/i],
    [productBody([]), /at least one photo/],
    [productBody([{ url: '/uploads/0123456789abcdef0123456789abcdef.jpg', thumbUrl: '/uploads/0123456789abcdef0123456789abcdef-t.jpg' }]), /photos? is missing/],
    [productBody([{ url: 'https://evil.example/x.jpg', thumbUrl: 'https://evil.example/x.jpg' }]), /photos? is missing/],
    [productBody([{ url: '/uploads/../store.db', thumbUrl: '/uploads/../store.db' }]), /photos? is missing/]
  ];
  for (const [body, pattern] of attempts) {
    const response = await t.request('POST', '/api/admin/products', { json: body, cookie });
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(response.data.error, pattern);
  }
});

test('cash on delivery order: prices come from the database, shipping is added', async () => {
  const product = (await t.request('GET', '/api/products')).data.find(p => p.price === 1500);
  const response = await t.request('POST', '/api/orders', {
    json: { method: 'cod', items: [{ id: product.id, quantity: 2, price: 1 }], customer, note: 'Please gift wrap', total: 1 }
  });
  assert.equal(response.status, 201, response.text);
  assert.equal(response.data.order.subtotal, 3000);
  assert.equal(response.data.order.shipping, 60);
  assert.equal(response.data.order.total, 3060);
  assert.match(response.data.order.number, /^NU\d+$/);
  assert.equal(response.data.razorpay, undefined);

  const orders = await t.request('GET', '/api/admin/orders', { cookie });
  const saved = orders.data.orders.find(o => o.number === response.data.order.number);
  assert.equal(saved.status, 'new');
  assert.equal(saved.paymentStatus, 'unpaid');
  assert.equal(saved.customer.phone, '919876543210');
  assert.equal(saved.items[0].name, product.name);
  assert.equal(saved.items[0].quantity, 2);
});

test('free shipping above the threshold', async () => {
  const product = (await t.request('GET', '/api/products')).data.find(p => p.price === 3780);
  const response = await t.request('POST', '/api/orders', { json: { method: 'cod', items: [{ id: product.id, quantity: 2 }], customer } });
  assert.equal(response.data.order.shipping, 0);
  assert.equal(response.data.order.total, 7560);
});

test('order validation and sold-out protection', async () => {
  const [first, second] = (await t.request('GET', '/api/products')).data;
  const base = { method: 'cod', items: [{ id: first.id, quantity: 1 }], customer };
  const cases = [
    [{ ...base, items: [] }, 400, /bag is empty/],
    [{ ...base, items: [{ id: first.id, quantity: 11 }] }, 400, /quantity/],
    [{ ...base, items: [{ id: first.id, quantity: 0 }] }, 400, /quantity/],
    [{ ...base, items: [{ id: 'no-such-product', quantity: 1 }] }, 409, /no longer available/],
    [{ ...base, customer: { ...customer, phone: '123' } }, 400, /mobile/],
    [{ ...base, customer: { ...customer, name: '' } }, 400, /name/],
    [{ ...base, customer: { ...customer, email: 'nope' } }, 400, /email/],
    [{ ...base, customer: { ...customer, address: 'short' } }, 400, /address/],
    [{ ...base, method: 'barter' }, 400, /how you would like to pay/]
  ];
  for (const [json, status, pattern] of cases) {
    const response = await t.request('POST', '/api/orders', { json });
    assert.equal(response.status, status, JSON.stringify(json).slice(0, 90));
    assert.match(response.data.error, pattern);
  }
  await t.request('PATCH', `/api/admin/products/${second.id}/stock`, { json: { inStock: false }, cookie });
  const soldOut = await t.request('POST', '/api/orders', { json: { ...base, items: [{ id: second.id, quantity: 1 }] } });
  assert.equal(soldOut.status, 409);
  assert.match(soldOut.data.error, /sold out/);
  await t.request('PATCH', `/api/admin/products/${second.id}/stock`, { json: { inStock: true }, cookie });
});

test('online payment: order, checkout signature, idempotent verify', async () => {
  const product = (await t.request('GET', '/api/products')).data[0];
  const created = await t.request('POST', '/api/orders', { json: { method: 'online', items: [{ id: product.id, quantity: 1 }], customer } });
  assert.equal(created.status, 201, created.text);
  const { order, razorpay } = created.data;
  assert.equal(razorpay.keyId, 'rzp_test_key');
  assert.equal(razorpay.amount, order.total * 100);
  assert.equal(razorpay.currency, 'INR');
  assert.equal(razorpay.prefill.contact, '+919876543210');
  assert.ok(!JSON.stringify(created.data).includes('rzp_test_secret'));
  assert.equal(t.razorpay.orders.at(-1).receipt, order.number);
  assert.equal(t.razorpay.orders.at(-1).amount, order.total * 100);

  const before = (await t.request('GET', '/api/admin/orders', { cookie })).data.orders.find(o => o.number === order.number);
  assert.equal(before.status, 'awaiting_payment');
  assert.equal(before.paymentStatus, 'unpaid');

  const paymentId = 'pay_ABC123';
  const forged = await t.request('POST', `/api/orders/${order.number}/verify`, { json: { razorpay_order_id: razorpay.orderId, razorpay_payment_id: paymentId, razorpay_signature: signCheckout(razorpay.orderId, paymentId, 'wrong-secret') } });
  assert.equal(forged.status, 400);
  const wrongOrder = await t.request('POST', `/api/orders/${order.number}/verify`, { json: { razorpay_order_id: 'order_OTHER', razorpay_payment_id: paymentId, razorpay_signature: signCheckout('order_OTHER', paymentId) } });
  assert.equal(wrongOrder.status, 400);
  const garbageSig = await t.request('POST', `/api/orders/${order.number}/verify`, { json: { razorpay_order_id: razorpay.orderId, razorpay_payment_id: paymentId, razorpay_signature: 'zz' } });
  assert.equal(garbageSig.status, 400);
  const stillUnpaid = (await t.request('GET', '/api/admin/orders', { cookie })).data.orders.find(o => o.number === order.number);
  assert.equal(stillUnpaid.paymentStatus, 'unpaid');

  const good = { razorpay_order_id: razorpay.orderId, razorpay_payment_id: paymentId, razorpay_signature: signCheckout(razorpay.orderId, paymentId) };
  const verified = await t.request('POST', `/api/orders/${order.number}/verify`, { json: good });
  assert.equal(verified.status, 200, verified.text);
  assert.equal(verified.data.paid, true);
  const again = await t.request('POST', `/api/orders/${order.number}/verify`, { json: good });
  assert.equal(again.status, 200);
  const after = (await t.request('GET', '/api/admin/orders', { cookie })).data.orders.find(o => o.number === order.number);
  assert.equal(after.paymentStatus, 'paid');
  assert.equal(after.status, 'new');
  assert.equal(after.razorpayPaymentId, paymentId);
});

test('webhook confirms payment even if the customer closed the page', async () => {
  const product = (await t.request('GET', '/api/products')).data[0];
  const created = await t.request('POST', '/api/orders', { json: { method: 'online', items: [{ id: product.id, quantity: 1 }], customer } });
  const { order, razorpay } = created.data;
  const event = amount => JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_WH1', order_id: razorpay.orderId, amount, status: 'captured' } } } });
  const post = (raw, signature) => t.request('POST', '/api/webhooks/razorpay', { body: raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } });
  const find = async () => (await t.request('GET', '/api/admin/orders', { cookie })).data.orders.find(o => o.number === order.number);

  assert.equal((await post(event(order.total * 100), 'deadbeef')).status, 400, 'bad signature');
  assert.equal((await post(event(order.total * 100), signWebhook(event(order.total * 100), 'other-secret'))).status, 400, 'signed with the wrong secret');
  assert.equal((await find()).paymentStatus, 'unpaid');

  const wrongAmount = event(100);
  assert.equal((await post(wrongAmount, signWebhook(wrongAmount))).status, 200);
  assert.equal((await find()).paymentStatus, 'unpaid', 'amount mismatch is ignored');

  const raw = event(order.total * 100);
  assert.equal((await post(raw, signWebhook(raw))).status, 200);
  const paid = await find();
  assert.equal(paid.paymentStatus, 'paid');
  assert.equal(paid.status, 'new');
  assert.equal((await post(raw, signWebhook(raw))).status, 200, 'replayed webhook is harmless');

  const unknown = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_X', order_id: 'order_NOPE', amount: 1, status: 'captured' } } } });
  assert.equal((await post(unknown, signWebhook(unknown))).status, 200);
});

test('when the payment gateway is down no half-created order is left behind', async () => {
  const product = (await t.request('GET', '/api/products')).data[0];
  const countBefore = t.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  t.razorpay.fail = true;
  const response = await t.request('POST', '/api/orders', { json: { method: 'online', items: [{ id: product.id, quantity: 1 }], customer } });
  t.razorpay.fail = false;
  assert.equal(response.status, 502);
  assert.match(response.data.error, /cash on delivery/i);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, countBefore);
});

test('owner manages orders', async () => {
  const orders = (await t.request('GET', '/api/admin/orders', { cookie })).data.orders;
  const target = orders.find(o => o.paymentMethod === 'cod');
  const updated = await t.request('PATCH', `/api/admin/orders/${target.id}`, { json: { status: 'shipped', paymentStatus: 'paid', tracking: 'India Post EE123456789IN' }, cookie });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.order.status, 'shipped');
  assert.equal(updated.data.order.paymentStatus, 'paid');
  assert.equal(updated.data.order.tracking, 'India Post EE123456789IN');
  assert.equal((await t.request('PATCH', `/api/admin/orders/${target.id}`, { json: { status: 'teleported' }, cookie })).status, 400);
  assert.equal((await t.request('PATCH', '/api/admin/orders/99999', { json: { status: 'new' }, cookie })).status, 404);
  const filtered = await t.request('GET', '/api/admin/orders?status=shipped', { cookie });
  assert.ok(filtered.data.orders.length >= 1 && filtered.data.orders.every(o => o.status === 'shipped'));
});

test('files outside the public folder cannot be reached', async () => {
  const attempts = ['/../server/config.js', '/%2e%2e/server/config.js', '/..%2fserver%2fconfig.js', '/uploads/../store.db', '/uploads/%2e%2e/store.db', '/.env', '/js/../../package.json', '/%00', '/store.db', '/server/config.js'];
  for (const attempt of attempts) {
    const response = await t.request('GET', attempt);
    assert.equal(response.status, 404, attempt);
    assert.doesNotMatch(response.text, /rzp_|password_hash|SQLite format/, attempt);
  }
});

test('changing the password signs out other sessions', async () => {
  const other = (await t.login()).cookie;
  const tooShort = await t.request('POST', '/api/admin/password', { json: { current: 'correct horse battery', next: 'short' }, cookie });
  assert.equal(tooShort.status, 400);
  const wrongCurrent = await t.request('POST', '/api/admin/password', { json: { current: 'incorrect password', next: 'a brand new passphrase' }, cookie });
  assert.equal(wrongCurrent.status, 400);
  const changed = await t.request('POST', '/api/admin/password', { json: { current: 'correct horse battery', next: 'a brand new passphrase' }, cookie });
  assert.equal(changed.status, 200);
  assert.equal((await t.request('GET', '/api/auth/me', { cookie })).data.admin.email, 'owner@example.com', 'current session continues');
  assert.equal((await t.request('GET', '/api/auth/me', { cookie: other })).data.admin, null, 'other session ended');
  assert.equal((await t.login('owner@example.com', 'correct horse battery')).response.status, 401);
  assert.equal((await t.login('owner@example.com', 'a brand new passphrase')).response.status, 200);
});

test('logout ends the session', async () => {
  const { cookie: mine } = await t.login('owner@example.com', 'a brand new passphrase');
  assert.equal((await t.request('POST', '/api/auth/logout', { json: {}, cookie: mine })).status, 200);
  assert.equal((await t.request('GET', '/api/admin/products', { cookie: mine })).status, 401);
});

// ---------- live-server defaults and first-time setup ----------

test('live defaults: online payment only and no sample catalog', () => {
  const { loadConfig } = require('../config');
  const live = loadConfig({ NODE_ENV: 'production' });
  assert.equal(live.codEnabled, false, 'cash on delivery must be opted into');
  assert.equal(live.seedSampleProducts, false, 'placeholder products must never go live by accident');
  assert.equal(loadConfig({ NODE_ENV: 'production', COD_ENABLED: 'true' }).codEnabled, true);
  assert.equal(loadConfig({}).seedSampleProducts, true, 'local development still gets sample products');
});

test('cash on delivery is refused when it is switched off', async () => {
  const off = await startTestServer({ COD_ENABLED: 'false', SEED_SAMPLE_PRODUCTS: 'false' });
  try {
    const config = await off.request('GET', '/api/config');
    assert.equal(config.data.cod, false);
    assert.equal(config.data.onlinePayments, true);
    const ownerCookie = (await off.login()).cookie;
    const upload = await off.upload(ownerCookie);
    const created = await off.request('POST', '/api/admin/products', { json: productBody([upload.data]), cookie: ownerCookie });
    assert.equal(created.status, 201, created.text);
    const refused = await off.request('POST', '/api/orders', { json: { method: 'cod', items: [{ id: created.data.id, quantity: 1 }], customer } });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /Cash on delivery/);
    const online = await off.request('POST', '/api/orders', { json: { method: 'online', items: [{ id: created.data.id, quantity: 1 }], customer } });
    assert.equal(online.status, 201, online.text);
    assert.ok(online.data.razorpay.orderId);
  } finally {
    await off.close();
  }
});

test('the owner login can be created from environment settings', async () => {
  const os = require('node:os');
  const { openDb } = require('../db');
  const { bootstrapAdmin, authenticate } = require('../auth');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nandini-boot-'));
  const db = openDb(dir);
  try {
    assert.equal(await bootstrapAdmin(db, {}), '', 'nothing happens without settings');
    assert.match(await bootstrapAdmin(db, { ADMIN_EMAIL: 'Shop@Example.com', ADMIN_PASSWORD: 'first password 1' }), /created/);
    assert.ok(await authenticate(db, 'shop@example.com', 'first password 1'));
    assert.equal(await bootstrapAdmin(db, { ADMIN_EMAIL: 'shop@example.com', ADMIN_PASSWORD: 'another password' }), '', 'an existing owner is never overwritten by accident');
    assert.equal(await authenticate(db, 'shop@example.com', 'another password'), null);
    assert.match(await bootstrapAdmin(db, { ADMIN_EMAIL: 'shop@example.com', ADMIN_PASSWORD: 'another password', RESET_ADMIN_PASSWORD: 'true' }), /reset/);
    assert.ok(await authenticate(db, 'shop@example.com', 'another password'));
    await assert.rejects(() => bootstrapAdmin(openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'nandini-boot2-'))), { ADMIN_EMAIL: 'x@example.com', ADMIN_PASSWORD: 'short' }), /at least 10/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sign-in limits are counted per visitor when a client IP header is configured', async () => {
  const proxied = await startTestServer({ TRUST_PROXY: 'true', CLIENT_IP_HEADER: 'x-real-ip', SEED_SAMPLE_PRODUCTS: 'false' });
  try {
    const attempt = (ip, n) => proxied.request('POST', '/api/auth/login', { json: { email: `guess${n}@example.com`, password: 'wrong password!' }, headers: { 'x-real-ip': ip } });
    for (let n = 1; n <= 8; n += 1) assert.equal((await attempt('10.0.0.1', n)).status, 401);
    assert.equal((await attempt('10.0.0.1', 9)).status, 429, 'ninth attempt from the same visitor is blocked');
    assert.equal((await attempt('10.0.0.2', 9)).status, 401, 'a different visitor is not blocked');
  } finally {
    await proxied.close();
  }
});
