'use strict';
const { HttpError } = require('./lib/web');
const { tx, now } = require('./db');
const { text, wholeNumber } = require('./catalog');

const ORDER_STATUSES = ['awaiting_payment', 'new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded'];

function parseOrderInput(cfg, input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid order.');
  if (!Array.isArray(input.items) || !input.items.length) throw new HttpError(400, 'Your bag is empty.');
  if (input.items.length > 20) throw new HttpError(400, 'Too many different items in one order.');
  const quantities = new Map();
  for (const item of input.items) {
    const id = String(item && item.id || '');
    const quantity = wholeNumber(item && item.quantity, 'quantity', { min: 1, max: 10 });
    quantities.set(id, Math.min(10, (quantities.get(id) || 0) + quantity));
  }
  const customer = input.customer || {};
  const digits = String(customer.phone || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) throw new HttpError(400, 'Enter a valid mobile number.');
  const email = text(customer.email, 'Email', { max: 120 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address or leave it blank.');
  const method = input.method === 'cod' ? 'cod' : input.method === 'online' ? 'online' : '';
  if (!method) throw new HttpError(400, 'Choose how you would like to pay.');
  if (method === 'online' && !cfg.onlinePayments) throw new HttpError(400, 'Online payment is not available right now.');
  if (method === 'cod' && !cfg.codEnabled) throw new HttpError(400, 'Cash on delivery is not available.');
  return {
    quantities,
    method,
    name: text(customer.name, 'Your name', { min: 2, max: 80 }),
    phone: digits.length === 10 ? `91${digits}` : digits,
    email,
    address: text(customer.address, 'Delivery address', { min: 10, max: 300 }),
    city: text(customer.city, 'City and PIN code', { min: 3, max: 80 }),
    note: text(input.note, 'Note', { max: 300 })
  };
}

function shippingFor(cfg, subtotal) {
  return cfg.freeShippingAbove > 0 && subtotal >= cfg.freeShippingAbove ? 0 : cfg.shippingFee;
}

/** Prices always come from the database, never from the browser. */
function createOrder(cfg, db, rawInput) {
  const input = parseOrderInput(cfg, rawInput);
  const ids = [...input.quantities.keys()];
  const found = db.prepare(`SELECT p.id, p.name, p.detail, p.price, p.in_stock,
      (SELECT thumb_url FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS thumb
    FROM products p WHERE p.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (found.length !== ids.length) throw new HttpError(409, 'Some items in your bag are no longer available. Please review your bag.');
  const soldOut = found.filter(product => !product.in_stock);
  if (soldOut.length) throw new HttpError(409, `Sorry, ${soldOut.map(product => product.name).join(', ')} just sold out. Please remove it from your bag.`);

  const lines = found.map(product => ({ ...product, quantity: input.quantities.get(product.id) }));
  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const shipping = shippingFor(cfg, subtotal);
  const total = subtotal + shipping;
  const status = input.method === 'online' ? 'awaiting_payment' : 'new';

  const order = tx(db, () => {
    const stamp = now();
    const inserted = db.prepare(`INSERT INTO orders (number, created_at, updated_at, status, payment_method, payment_status, customer_name, customer_phone, customer_email, address, city, note, subtotal, shipping, total)
      VALUES (?, ?, ?, ?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`tmp-${Math.random()}`, stamp, stamp, status, input.method, input.name, input.phone, input.email, input.address, input.city, input.note, subtotal, shipping, total);
    const id = Number(inserted.lastInsertRowid);
    const number = `NU${1000 + id}`;
    db.prepare('UPDATE orders SET number = ? WHERE id = ?').run(number, id);
    const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, detail, price, quantity, image) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const line of lines) insertItem.run(id, line.id, line.name, line.detail, line.price, line.quantity, line.thumb || '');
    return { id, number, subtotal, shipping, total, method: input.method, name: input.name, phone: input.phone, email: input.email };
  });
  return order;
}

function attachRazorpayOrder(db, orderId, razorpayOrderId) {
  db.prepare('UPDATE orders SET razorpay_order_id = ?, updated_at = ? WHERE id = ?').run(razorpayOrderId, now(), orderId);
}

/** Remove an order that never reached the payment gateway. */
function discardOrder(db, orderId) {
  db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
}

function findByNumber(db, number) {
  return db.prepare('SELECT * FROM orders WHERE number = ?').get(String(number || '')) || null;
}

function findByRazorpayOrder(db, razorpayOrderId) {
  return db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(String(razorpayOrderId || '')) || null;
}

/** Idempotent: verify route and webhook may both report the same payment. */
function markPaid(db, order, { paymentId, source, event }) {
  return tx(db, () => {
    const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    db.prepare('INSERT OR IGNORE INTO payment_events (order_id, source, event, payment_id, created_at) VALUES (?, ?, ?, ?, ?)').run(order.id, source, event, paymentId || '', now());
    if (fresh.payment_status === 'paid') return { changed: false, order: fresh };
    const status = fresh.status === 'awaiting_payment' ? 'new' : fresh.status;
    db.prepare("UPDATE orders SET payment_status = 'paid', status = ?, razorpay_payment_id = ?, updated_at = ? WHERE id = ?").run(status, paymentId || fresh.razorpay_payment_id, now(), order.id);
    return { changed: true, order: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id) };
  });
}

function shapeOrders(db, rows) {
  if (!rows.length) return [];
  const items = db.prepare(`SELECT order_id, product_id, name, detail, price, quantity, image FROM order_items WHERE order_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`).all(...rows.map(row => row.id));
  const byOrder = new Map();
  for (const item of items) {
    if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
    byOrder.get(item.order_id).push({ productId: item.product_id, name: item.name, detail: item.detail, price: item.price, quantity: item.quantity, image: item.image });
  }
  return rows.map(row => ({
    id: row.id,
    number: row.number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    customer: { name: row.customer_name, phone: row.customer_phone, email: row.customer_email },
    address: row.address,
    city: row.city,
    note: row.note,
    subtotal: row.subtotal,
    shipping: row.shipping,
    total: row.total,
    tracking: row.tracking,
    razorpayPaymentId: row.razorpay_payment_id,
    items: byOrder.get(row.id) || []
  }));
}

function listOrders(db, { status = '', limit = 200 } = {}) {
  const rows = status && ORDER_STATUSES.includes(status)
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(limit);
  return shapeOrders(db, rows);
}

function updateOrder(db, id, input) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw new HttpError(404, 'Order not found.');
  const status = input.status === undefined ? order.status : String(input.status);
  const paymentStatus = input.paymentStatus === undefined ? order.payment_status : String(input.paymentStatus);
  if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Unknown order status.');
  if (!PAYMENT_STATUSES.includes(paymentStatus)) throw new HttpError(400, 'Unknown payment status.');
  const tracking = input.tracking === undefined ? order.tracking : text(input.tracking, 'Tracking note', { max: 160 });
  db.prepare('UPDATE orders SET status = ?, payment_status = ?, tracking = ?, updated_at = ? WHERE id = ?').run(status, paymentStatus, tracking, now(), id);
  return shapeOrders(db, [db.prepare('SELECT * FROM orders WHERE id = ?').get(id)])[0];
}

module.exports = { ORDER_STATUSES, PAYMENT_STATUSES, createOrder, attachRazorpayOrder, discardOrder, findByNumber, findByRazorpayOrder, markPaid, listOrders, updateOrder, shippingFor };
