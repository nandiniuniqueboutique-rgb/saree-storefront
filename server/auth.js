'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { now } = require('./db');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const COST = { N: 16384, r: 8, p: 1 };
const COOKIE_NAME = 'nu_session';
const MIN_PASSWORD_LENGTH = 10;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Used so a login for an unknown email takes as long as one for a real account.
const DUMMY_HASH = `scrypt$${COST.N}$${COST.r}$${COST.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEY_LENGTH).toString('base64')}`;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return 'That password is too long.';
  if (/^(.)\1+$/.test(password)) return 'Choose a less predictable password.';
  return '';
}

async function createAdmin(db, email, password) {
  const problem = checkPasswordStrength(password);
  if (problem) throw new Error(problem);
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Enter a valid email address.');
  const hash = await hashPassword(password);
  const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(cleanEmail);
  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(existing.id);
    return { id: existing.id, email: cleanEmail, created: false };
  }
  const result = db.prepare('INSERT INTO admins (email, password_hash, created_at) VALUES (?, ?, ?)').run(cleanEmail, hash, now());
  return { id: Number(result.lastInsertRowid), email: cleanEmail, created: true };
}

/**
 * Create the owner login from ADMIN_EMAIL and ADMIN_PASSWORD when the shop has none yet, so no shell access is needed.
 * To recover a forgotten password, set RESET_ADMIN_PASSWORD=true together with both variables, redeploy, then remove all three.
 * Returns a short message for the log, or '' when nothing was done.
 */
async function bootstrapAdmin(db, env) {
  const email = String(env.ADMIN_EMAIL || '').trim();
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) return '';
  const hasAdmin = db.prepare('SELECT 1 FROM admins LIMIT 1').get();
  const reset = /^(1|true|yes|on)$/i.test(String(env.RESET_ADMIN_PASSWORD || ''));
  if (hasAdmin && !reset) return '';
  const result = await createAdmin(db, email, password);
  return result.created ? `Owner login created for ${result.email}. Remove ADMIN_PASSWORD from the environment now.` : `Password reset for ${result.email}. Remove ADMIN_PASSWORD and RESET_ADMIN_PASSWORD from the environment now.`;
}

async function authenticate(db, email, password) {
  const admin = db.prepare('SELECT id, email, password_hash FROM admins WHERE email = ?').get(String(email || '').trim().toLowerCase());
  const ok = await verifyPassword(String(password || ''), admin ? admin.password_hash : DUMMY_HASH);
  return admin && ok ? { id: admin.id, email: admin.email } : null;
}

function createSession(db, cfg, adminId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const created = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(created);
  db.prepare('INSERT INTO sessions (token_hash, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), adminId, created, created + cfg.sessionHours * 3_600_000);
  return { token, maxAge: cfg.sessionHours * 3600 };
}

function adminFromToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT admins.id AS id, admins.email AS email FROM sessions
    JOIN admins ON admins.id = sessions.admin_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(sha256(token), Date.now());
  return row ? { id: row.id, email: row.email } : null;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

module.exports = { COOKIE_NAME, hashPassword, verifyPassword, checkPasswordStrength, createAdmin, bootstrapAdmin, authenticate, createSession, adminFromToken, destroySession, sha256 };
