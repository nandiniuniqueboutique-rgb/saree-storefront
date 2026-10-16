'use strict';
/** Delete uploaded photos that no product uses (for example, photos picked and then abandoned in the editor). */
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, loadEnvFile } = require('../config');

loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));
const cfg = loadConfig();
const { openDb } = require('../db');

const db = openDb(cfg.dataDir);
const used = new Set();
for (const row of db.prepare('SELECT url, thumb_url FROM product_images').all()) {
  used.add(path.basename(row.url));
  used.add(path.basename(row.thumb_url));
}
const directory = path.join(cfg.dataDir, 'uploads');
let removed = 0;
for (const name of fs.readdirSync(directory)) {
  const file = path.join(directory, name);
  if (!/^[0-9a-f]{32}(-t)?\.jpg$/.test(name) || used.has(name)) continue;
  if (Date.now() - fs.statSync(file).mtimeMs < 24 * 3_600_000) continue; // leave recent uploads alone
  fs.rmSync(file);
  removed += 1;
}
db.close();
console.log(`Removed ${removed} unused photo file(s).`);
