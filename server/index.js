'use strict';
const path = require('node:path');
const { loadConfig, loadEnvFile } = require('./config');

loadEnvFile(path.resolve(__dirname, '..', '.env'));
const cfg = loadConfig();
const { openDb } = require('./db');
const { createApp } = require('./app');
const { bootstrapAdmin } = require('./auth');

async function main() {
  const db = openDb(cfg.dataDir);
  try {
    const message = await bootstrapAdmin(db, process.env);
    if (message) console.log(JSON.stringify({ event: 'admin.bootstrap', message }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'admin.bootstrap_failed', message: error.message }));
  }
  const hasAdmin = Boolean(db.prepare('SELECT 1 FROM admins LIMIT 1').get());
  const app = createApp(cfg, db);

  app.server.listen(cfg.port, cfg.host, () => {
    console.log(JSON.stringify({
      event: 'server.started',
      url: `http://${cfg.host}:${cfg.port}`,
      onlinePayments: cfg.onlinePayments,
      webhook: Boolean(cfg.razorpay.webhookSecret),
      cod: cfg.codEnabled,
      dataDir: cfg.dataDir
    }));
    if (!hasAdmin) console.warn('There is no owner login yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (or run "npm run create-admin -- you@example.com") and restart.');
    if (cfg.production && !cfg.secureCookies) console.warn('SECURE_COOKIES is off; owner login cookies will be sent without the Secure flag.');
    if (!cfg.onlinePayments) console.warn('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set, so customers cannot pay online yet.');
    if (cfg.onlinePayments && !cfg.razorpay.webhookSecret) console.warn('RAZORPAY_WEBHOOK_SECRET is not set. Payments are confirmed from the browser only; set up the webhook so they are also confirmed if the customer closes the page.');
  });

  function shutdown() {
    app.close().then(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
