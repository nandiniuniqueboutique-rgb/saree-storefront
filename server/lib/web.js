'use strict';
/**
 * A very small web toolkit built on node:http so the server needs no npm packages:
 * routing, body reading, multipart parsing, cookies, static files and rate limiting.
 */
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json'
};

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, ...headers });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      return reject(new HttpError(413, 'That request is too large.'));
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => (tooLarge ? reject(new HttpError(413, 'That request is too large.')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try { cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* ignore bad cookie */ }
  }
  return cookies;
}

function serializeCookie(name, value, { maxAge, httpOnly = true, sameSite = 'Strict', secure = false, path: cookiePath = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`, `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Parse a multipart/form-data body held in memory. Returns [{ name, filename, contentType, data }]. */
function parseMultipart(buffer, contentType, { maxParts = 8 } = {}) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new HttpError(400, 'Invalid upload.');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const delimiter = Buffer.concat([Buffer.from('\r\n'), boundary]);
  const parts = [];
  let pos = buffer.indexOf(boundary);
  if (pos === -1) throw new HttpError(400, 'Invalid upload.');
  for (;;) {
    pos += boundary.length;
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    if (buffer[pos] !== 0x0d || buffer[pos + 1] !== 0x0a) throw new HttpError(400, 'Invalid upload.');
    pos += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1 || headerEnd - pos > 4096) throw new HttpError(400, 'Invalid upload.');
    const headerText = buffer.toString('utf8', pos, headerEnd);
    const next = buffer.indexOf(delimiter, headerEnd + 4);
    if (next === -1) throw new HttpError(400, 'Invalid upload.');
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const disposition = headers['content-disposition'] || '';
    const name = /\bname="([^"]*)"/.exec(disposition);
    const filename = /\bfilename="([^"]*)"/.exec(disposition);
    parts.push({ name: name ? name[1] : '', filename: filename ? filename[1] : null, contentType: headers['content-type'] || '', data: buffer.subarray(headerEnd + 4, next) });
    if (parts.length > maxParts) throw new HttpError(400, 'Too many files in one upload.');
    pos = next + 2;
  }
  return parts;
}

/** Fixed-window-per-key limiter kept in memory. */
function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, list] of hits) {
      const fresh = list.filter(time => now - time < windowMs);
      if (fresh.length) hits.set(key, fresh); else hits.delete(key);
    }
  }, 60_000);
  timer.unref();
  return {
    take(key) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter(time => now - time < windowMs);
      if (list.length >= max) { hits.set(key, list); return false; }
      list.push(now);
      hits.set(key, list);
      return true;
    },
    reset(key) { hits.delete(key); },
    stop() { clearInterval(timer); }
  };
}

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, options = {}) {
    const keys = [];
    const rx = new RegExp(`^${pattern.replace(/:([A-Za-z]+)/g, (_, key) => { keys.push(key); return '([^/]+)'; })}/?$`);
    this.routes.push({ method, rx, keys, handler, options });
  }
  get(pattern, handler, options) { this.add('GET', pattern, handler, options); }
  post(pattern, handler, options) { this.add('POST', pattern, handler, options); }
  put(pattern, handler, options) { this.add('PUT', pattern, handler, options); }
  patch(pattern, handler, options) { this.add('PATCH', pattern, handler, options); }
  delete(pattern, handler, options) { this.add('DELETE', pattern, handler, options); }
  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const found = route.rx.exec(pathname);
      if (!found) continue;
      pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = {};
      route.keys.forEach((key, index) => { try { params[key] = decodeURIComponent(found[index + 1]); } catch { params[key] = found[index + 1]; } });
      return { route, params };
    }
    return { route: null, pathMatched };
  }
}

/** Serve a file from `root`; returns false when nothing suitable exists. */
function serveFile(req, res, root, relativePath, { cache = 'no-cache', extraHeaders = {} } = {}) {
  let decoded;
  try { decoded = decodeURIComponent(relativePath); } catch { return false; }
  if (decoded.includes('\0')) return false;
  const normalized = path.posix.normalize(`/${decoded}`);
  const full = path.resolve(root, `.${normalized}`);
  if (!full.startsWith(root + path.sep)) return false;
  if (normalized.split('/').some(segment => segment.startsWith('.'))) return false;
  let stat;
  try { stat = fs.statSync(full); } catch { return false; }
  if (!stat.isFile()) return false;
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': cache,
    ETag: etag,
    ...extraHeaders
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  const stream = fs.createReadStream(full);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

module.exports = { HttpError, sendJson, readBody, parseCookies, serializeCookie, parseMultipart, createLimiter, Router, serveFile };
