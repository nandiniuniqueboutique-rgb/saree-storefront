'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Load KEY=VALUE lines from a .env file without overriding variables that are already set. */
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

const bool = (value, fallback) => (value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(String(value)));
const int = (value, fallback) => { const n = Number.parseInt(value, 10); return Number.isFinite(n) ? n : fallback; };

function loadConfig(env = process.env, overrides = {}) {
  const root = path.resolve(__dirname, '..');
  const production = env.NODE_ENV === 'production';
  const cfg = {
    root,
    production,
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
    publicDir: path.resolve(env.PUBLIC_DIR || path.join(root, 'public')),
    seedFile: path.resolve(env.SEED_FILE || path.join(root, 'seed', 'products.json')),
    // The sample catalog uses placeholder photos, so it is never loaded on a live (production) server unless asked for.
    seedSampleProducts: bool(env.SEED_SAMPLE_PRODUCTS, !production),
    // Trust X-Forwarded-* only when a reverse proxy (Render, Caddy) sits in front of the app.
    trustProxy: bool(env.TRUST_PROXY, production),
    // Optional: read the visitor's IP from this header instead (for example "cf-connecting-ip" behind Cloudflare).
    clientIpHeader: String(env.CLIENT_IP_HEADER || '').trim().toLowerCase(),
    // Cookies are marked Secure when the site is served over HTTPS.
    secureCookies: bool(env.SECURE_COOKIES, production),
    sessionHours: int(env.SESSION_HOURS, 12),
    storeName: env.STORE_NAME || 'Nandini Unique Boutique',
    whatsapp: (env.WHATSAPP_NUMBER || '917411211052').replace(/\D/g, ''),
    // Cash on delivery is off unless COD_ENABLED=true; the default checkout is online payment only.
    codEnabled: bool(env.COD_ENABLED, false),
    shippingFee: int(env.SHIPPING_FEE, 0),
    freeShippingAbove: int(env.FREE_SHIPPING_ABOVE, 0),
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID || '',
      keySecret: env.RAZORPAY_KEY_SECRET || '',
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
      apiBase: (env.RAZORPAY_API_BASE || 'https://api.razorpay.com').replace(/\/$/, '')
    },
    ...overrides
  };
  cfg.onlinePayments = Boolean(cfg.razorpay.keyId && cfg.razorpay.keySecret);
  return cfg;
}

module.exports = { loadConfig, loadEnvFile };
