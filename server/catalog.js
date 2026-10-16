'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./lib/web');
const { tx, now } = require('./db');

const MAX_PHOTOS = 6;
const LOCAL_URL = /^\/uploads\/[0-9a-f]{32}\.jpg$/;
const LOCAL_THUMB = /^\/uploads\/[0-9a-f]{32}-t\.jpg$/;

function text(value, label, { min = 0, max = 200 } = {}) {
  const clean = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (clean.length < min) throw new HttpError(400, `${label} is required.`);
  if (clean.length > max) throw new HttpError(400, `${label} must be at most ${max} characters.`);
  return clean;
}

function wholeNumber(value, label, { min = 1, max = 10_000_000 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new HttpError(400, `Enter a valid ${label}.`);
  return number;
}

function shapeProducts(db, where = '', params = []) {
  const rows = db.prepare(`SELECT * FROM products ${where} ORDER BY sort_order ASC, created_at DESC`).all(...params);
  if (!rows.length) return [];
  const images = db.prepare('SELECT product_id, url, thumb_url FROM product_images ORDER BY product_id, position ASC').all();
  const byProduct = new Map();
  for (const image of images) {
    if (!byProduct.has(image.product_id)) byProduct.set(image.product_id, []);
    byProduct.get(image.product_id).push({ url: image.url, thumbUrl: image.thumb_url });
  }
  return rows.map(row => {
    const photos = byProduct.get(row.id) || [];
    return {
      id: row.id,
      name: row.name,
      detail: row.detail,
      description: row.description,
      type: row.type,
      category: row.category,
      price: row.price,
      originalPrice: row.original_price,
      tag: row.tag,
      alt: row.alt || row.name,
      inStock: Boolean(row.in_stock),
      image: photos[0] ? photos[0].url : '',
      thumb: photos[0] ? photos[0].thumbUrl : '',
      images: photos.map(photo => photo.url),
      photos
    };
  });
}

const listProducts = db => shapeProducts(db);
const getProduct = (db, id) => shapeProducts(db, 'WHERE id = ?', [id])[0] || null;

function uploadPath(cfg, url) {
  return path.join(cfg.dataDir, 'uploads', path.basename(url));
}

function validateImages(cfg, db, input, existingId) {
  if (!Array.isArray(input) || !input.length) throw new HttpError(400, 'Add at least one photo.');
  if (input.length > MAX_PHOTOS) throw new HttpError(400, `Use at most ${MAX_PHOTOS} photos per product.`);
  const known = new Set();
  if (existingId) {
    for (const row of db.prepare('SELECT url, thumb_url FROM product_images WHERE product_id = ?').all(existingId)) { known.add(row.url); known.add(row.thumb_url); }
  }
  const seen = new Set();
  return input.map(item => {
    const url = String(item && item.url || '');
    const thumbUrl = String(item && item.thumbUrl || '');
    const kept = known.has(url) && known.has(thumbUrl);
    const uploaded = LOCAL_URL.test(url) && LOCAL_THUMB.test(thumbUrl) && url.slice(9, 41) === thumbUrl.slice(9, 41)
      && fs.existsSync(uploadPath(cfg, url)) && fs.existsSync(uploadPath(cfg, thumbUrl));
    if (!kept && !uploaded) throw new HttpError(400, 'One of the photos is missing. Upload it again.');
    if (seen.has(url)) throw new HttpError(400, 'The same photo was added twice.');
    seen.add(url);
    return { url, thumbUrl };
  });
}

function parseProduct(cfg, db, input, existingId) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid product.');
  const name = text(input.name, 'Product name', { min: 1, max: 90 });
  const price = wholeNumber(input.price, 'price');
  let originalPrice = null;
  if (input.originalPrice !== null && input.originalPrice !== undefined && input.originalPrice !== '') {
    originalPrice = wholeNumber(input.originalPrice, 'original price');
    if (originalPrice <= price) throw new HttpError(400, 'The original price must be higher than the selling price.');
  }
  const typedCategory = text(input.category, 'Category', { min: 1, max: 40 });
  const match = db.prepare('SELECT category FROM products WHERE lower(category) = lower(?) LIMIT 1').get(typedCategory);
  return {
    name,
    detail: text(input.detail, 'Fabric or style', { max: 100 }),
    description: text(input.description, 'Description', { max: 1500 }),
    type: input.type === 'Dress' ? 'Dress' : 'Saree',
    category: match ? match.category : typedCategory.charAt(0).toUpperCase() + typedCategory.slice(1),
    price,
    originalPrice,
    tag: text(input.tag, 'Label', { max: 40 }),
    alt: text(input.alt, 'Photo description', { max: 160 }) || name,
    inStock: input.inStock !== false,
    images: validateImages(cfg, db, input.images, existingId)
  };
}

function removeFiles(cfg, db, urls) {
  for (const url of urls) {
    if (!LOCAL_URL.test(url) && !LOCAL_THUMB.test(url)) continue;
    if (db.prepare('SELECT 1 FROM product_images WHERE url = ? OR thumb_url = ?').get(url, url)) continue;
    fs.rmSync(uploadPath(cfg, url), { force: true });
  }
}

function writeImages(db, productId, images) {
  db.prepare('DELETE FROM product_images WHERE product_id = ?').run(productId);
  const insert = db.prepare('INSERT INTO product_images (product_id, url, thumb_url, position) VALUES (?, ?, ?, ?)');
  images.forEach((image, index) => insert.run(productId, image.url, image.thumbUrl, index));
}

function createProduct(cfg, db, input) {
  const product = parseProduct(cfg, db, input, null);
  const slug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'product';
  const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
  tx(db, () => {
    // New products appear first in the shop.
    const first = db.prepare('SELECT MIN(sort_order) AS m FROM products').get().m;
    db.prepare(`INSERT INTO products (id, name, detail, description, type, category, price, original_price, tag, alt, in_stock, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, product.name, product.detail, product.description, product.type, product.category, product.price, product.originalPrice,
        product.tag || 'New arrival', product.alt, product.inStock ? 1 : 0, (first === null ? 0 : first - 1), now(), now());
    writeImages(db, id, product.images);
  });
  return getProduct(db, id);
}

function updateProduct(cfg, db, id, input) {
  const existing = getProduct(db, id);
  if (!existing) throw new HttpError(404, 'Product not found.');
  const product = parseProduct(cfg, db, input, id);
  const before = [...existing.photos.flatMap(photo => [photo.url, photo.thumbUrl])];
  tx(db, () => {
    db.prepare(`UPDATE products SET name = ?, detail = ?, description = ?, type = ?, category = ?, price = ?, original_price = ?, tag = ?, alt = ?, in_stock = ?, updated_at = ? WHERE id = ?`)
      .run(product.name, product.detail, product.description, product.type, product.category, product.price, product.originalPrice, product.tag || 'New arrival', product.alt, product.inStock ? 1 : 0, now(), id);
    writeImages(db, id, product.images);
  });
  removeFiles(cfg, db, before);
  return getProduct(db, id);
}

function deleteProduct(cfg, db, id) {
  const existing = getProduct(db, id);
  if (!existing) throw new HttpError(404, 'Product not found.');
  const files = existing.photos.flatMap(photo => [photo.url, photo.thumbUrl]);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  removeFiles(cfg, db, files);
}

function setStock(db, id, inStock) {
  const result = db.prepare('UPDATE products SET in_stock = ?, updated_at = ? WHERE id = ?').run(inStock ? 1 : 0, now(), id);
  if (!result.changes) throw new HttpError(404, 'Product not found.');
  return getProduct(db, id);
}

module.exports = { MAX_PHOTOS, listProducts, getProduct, createProduct, updateProduct, deleteProduct, setStock, text, wholeNumber };
