'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Each entry upgrades the database by one version (tracked with PRAGMA user_version).
const MIGRATIONS = [`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'Saree' CHECK (type IN ('Saree', 'Dress')),
    category TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    original_price INTEGER,
    tag TEXT NOT NULL DEFAULT '',
    alt TEXT NOT NULL DEFAULT '',
    in_stock INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    thumb_url TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE INDEX product_images_product ON product_images(product_id, position);

  CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    customer_email TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    subtotal INTEGER NOT NULL,
    shipping INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    tracking TEXT NOT NULL DEFAULT '',
    razorpay_order_id TEXT UNIQUE,
    razorpay_payment_id TEXT
  );
  CREATE INDEX orders_status ON orders(status, created_at);

  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT,
    name TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    image TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    event TEXT NOT NULL,
    payment_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (source, event, payment_id)
  );
`];

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'store.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

/** Run `fn` inside a write transaction. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

const now = () => new Date().toISOString();

/** On the very first start, load the sample catalog so the shop is not empty. */
function seedIfNeeded(db, cfg) {
  if (db.prepare("SELECT value FROM meta WHERE key = 'seeded'").get()) return 0;
  db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', '1')").run();
  if (!cfg.seedSampleProducts) return 0;
  if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n) return 0;
  let items;
  try { items = JSON.parse(fs.readFileSync(cfg.seedFile, 'utf8')); } catch { return 0; }
  if (!Array.isArray(items)) return 0;
  const insertProduct = db.prepare(`INSERT INTO products (id, name, detail, description, type, category, price, original_price, tag, alt, in_stock, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`);
  const insertImage = db.prepare('INSERT INTO product_images (product_id, url, thumb_url, position) VALUES (?, ?, ?, 0)');
  let count = 0;
  tx(db, () => {
    items.forEach((item, index) => {
      if (!item || !item.id || !item.name || !(item.price > 0) || !/^https:\/\//.test(item.image || '')) return;
      insertProduct.run(String(item.id), String(item.name), String(item.detail || ''), String(item.description || ''), item.type === 'Dress' ? 'Dress' : 'Saree',
        String(item.category || 'Everyday'), item.price, item.originalPrice || null, String(item.tag || ''), String(item.alt || item.name), index, now(), now());
      insertImage.run(String(item.id), item.image, item.image);
      count += 1;
    });
  });
  return count;
}

module.exports = { openDb, tx, now, seedIfNeeded };
