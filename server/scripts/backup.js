'use strict';
/**
 * Write a consistent copy of the database to data/backups and keep the newest 14.
 * Photos live in data/uploads and are never rewritten, so copy that folder (rsync or a server snapshot) as well.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, loadEnvFile } = require('../config');

loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));
const cfg = loadConfig();
const { openDb } = require('../db');

const db = openDb(cfg.dataDir);
const directory = path.join(cfg.dataDir, 'backups');
fs.mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const target = path.join(directory, `store-${stamp}.db`);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

const backups = fs.readdirSync(directory).filter(name => /^store-\d{8}-\d{6}\.db$/.test(name)).sort();
for (const old of backups.slice(0, Math.max(0, backups.length - 14))) fs.rmSync(path.join(directory, old), { force: true });
console.log(`Database backed up to ${target} (${Math.min(backups.length, 14)} kept).`);
