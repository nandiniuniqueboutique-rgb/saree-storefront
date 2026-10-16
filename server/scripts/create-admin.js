'use strict';
/**
 * Create the owner account, or reset its password:
 *   node server/scripts/create-admin.js owner@example.com
 * The password is typed at a hidden prompt (or read from the ADMIN_PASSWORD variable for scripted use).
 */
const path = require('node:path');
const readline = require('node:readline');
const { loadConfig, loadEnvFile } = require('../config');

loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));
const cfg = loadConfig();
const { openDb } = require('../db');
const { createAdmin } = require('../auth');

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(question); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node server/scripts/create-admin.js owner@example.com');
    process.exit(1);
  }
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await askHidden('New password (at least 10 characters): ');
    const again = await askHidden('Type it again: ');
    if (password !== again) { console.error('The two passwords do not match.'); process.exit(1); }
  }
  const db = openDb(cfg.dataDir);
  try {
    const result = await createAdmin(db, email, password);
    console.log(result.created ? `Owner account created for ${result.email}.` : `Password updated for ${result.email}. All other sign-ins were signed out.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  } finally {
    db.close();
  }
})();
