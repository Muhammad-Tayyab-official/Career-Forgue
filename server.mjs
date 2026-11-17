import { createHash, randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { extractDocx, extractText } from './resume-import.mjs';
import { extractOpportunity } from './extract-opportunity.mjs';

const project = dirname(fileURLToPath(import.meta.url));
const dist = resolve(project, 'dist');
const databaseFile = process.env.CAREERFORGE_DB || resolve(project, 'data', 'careerforge.sqlite');
const databasePath = databaseFile === ':memory:' ? databaseFile : resolve(databaseFile);
const port = Number(process.env.PORT || 4310);
const sessionName = 'careerforge_session';
const sessionAge = 60 * 60 * 24 * 14;
const stateLimit = 2 * 1024 * 1024;
const fileLimit = 8 * 1024 * 1024;
const scrypt = promisify(deriveKey);
const dummySalt = randomBytes(16);

if (databasePath !== ':memory:') {
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const databaseFileHandle = await open(databasePath, 'a', 0o600);
  await databaseFileHandle.close();
}
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    salt BLOB NOT NULL,
    password_hash BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS workspaces (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function readCookie(req) {
  const pattern = /(?:^|;\s*)careerforge_session=([a-f0-9]{64})(?:;|$)/;
  return (req.headers.cookie ?? '').match(pattern)?.[1];
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function userFor(req) {
  const token = readCookie(req);
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.name, u.email FROM users u JOIN sessions s ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash(token), Date.now()) ?? null;
}

function sessionCookie(token, age) {
  return `${sessionName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}`;
}

function startSession(req, res, user, status) {
  const oldToken = readCookie(req);
  if (oldToken) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(oldToken));
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), user.id, now + sessionAge * 1_000);
  return reply(res, status, { user: { id: user.id, name: user.name, email: user.email } }, { 'Set-Cookie': sessionCookie(token, sessionAge) });
}

function requireSameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
    throw new HttpError(403, 'Requests from other sites are not allowed.');
  }
}

async function readBytes(req, limit) {
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    throw new HttpError(413, 'The uploaded data is too large.');
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      req.resume();
      throw new HttpError(413, 'The uploaded data is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(req, limit = 12 * 1024) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON for this request.');
  const bytes = await readBytes(req, limit);
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (isObject(value)) return value;
  } catch {
    // Syntax and shape errors use the same response.
  }
  throw new HttpError(400, 'The request is not a valid JSON object.');
}

const attempts = new Map();

function rateLimit(key, maximum, windowMs) {
  const now = Date.now();
  if (attempts.size > 1_000) {
    for (const [name, entry] of attempts) {
      if (entry.until < now) attempts.delete(name);
    }
  }
  const entry = attempts.get(key);
  if (!entry || entry.until < now) {
    if (attempts.size >= 2_000) throw new HttpError(429, 'Please try again in a few minutes.');
    attempts.set(key, { count: 1, until: now + windowMs });
    return;
  }
  if (entry.count >= maximum) throw new HttpError(429, 'Please try again in a few minutes.');
  entry.count++;
}

function accountInput(body, registering) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const password = body.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length > 512 || (registering ? password.length < 8 : !password.length)) {
    throw new HttpError(400, registering ? 'Use a password between 8 and 512 characters.' : 'Enter a valid password.');
  }
  if (registering && (!name || name.length > 100)) throw new HttpError(400, 'Enter a name between 1 and 100 characters.');
  return { email, name, password };
}

async function authenticate(req, res, registering) {
  const { name, email, password } = accountInput(await readJson(req), registering);
  rateLimit(`auth:${req.socket.remoteAddress}`, 35, 300_000);
  rateLimit(`auth:${email}`, 12, 300_000);
  const existing = db.prepare('SELECT id, name, email, salt, password_hash FROM users WHERE email = ?').get(email);
  if (!registering) {
    const candidate = await scrypt(password, existing?.salt ?? dummySalt, 64);
    if (!existing || !timingSafeEqual(candidate, existing.password_hash)) throw new HttpError(401, 'Email or password is incorrect.');
    return startSession(req, res, existing, 200);
  }
  if (existing) throw new HttpError(409, 'An account already uses this email.');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  const user = { id: randomUUID(), name, email };
  const inserted = db.prepare('INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?, ?, ?)').run(user.id, name, email, salt, hash, Date.now());
  if (inserted.changes === 0) throw new HttpError(409, 'An account already uses this email.');
  return startSession(req, res, user, 201);
}

function validWorkspace(state) {
  if (!isObject(state) || !isObject(state.profile) || (state.opportunity !== null && !isObject(state.opportunity))) return false;
  return ['documents', 'applications', 'messages'].every((key) => Array.isArray(state[key]) && state[key].length <= 2_000 && state[key].every(isObject));
}

function pdfText(bytes) {
  if (!bytes.subarray(0, 1024).includes('%PDF-')) throw new HttpError(422, 'This file does not have a valid PDF header.');
  return new Promise((resolveText, reject) => {
    const child = spawn(process.env.CAREERFORGE_PYTHON || 'python', [resolve(project, 'pdf-import.py')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const unavailable = () => new HttpError(503, 'PDF import needs Python with pypdf. Use DOCX or paste the résumé text.');
    const timer = setTimeout(() => {
      child.kill();
      reject(new HttpError(422, 'Reading this PDF took too long. Try DOCX or paste the résumé text.'));
    }, 12_000);
    const chunks = [];
    let length = 0;
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > 480_000) {
        child.kill();
        reject(new HttpError(422, 'The résumé contains too much text.'));
      } else {
        chunks.push(chunk);
      }
    });
    child.once('error', () => reject(unavailable()));
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolveText(Buffer.concat(chunks).toString('utf8'));
      if (code === 2) return reject(unavailable());
      const message = code === 4 ? 'This PDF has no selectable text. Try DOCX or paste the résumé text.' : 'The PDF is damaged, password protected, or over the supported limit.';
      reject(new HttpError(422, message));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

async function importResume(req, res, user) {
  rateLimit(`import:${user.id}`, 12, 60_000);
  const type = (req.headers['content-type'] ?? '').split(';')[0].toLowerCase();
  const bytes = await readBytes(req, fileLimit);
  const isDocx = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isPdf = bytes.subarray(0, 1024).includes('%PDF-');
  try {
    if (type === 'application/pdf' || isPdf) return reply(res, 200, { text: await pdfText(bytes) });
    if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || isDocx) {
      return reply(res, 200, { text: await extractDocx(bytes) });
    }
    if (type === 'text/plain') return reply(res, 200, { text: extractText(bytes) });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = /^(?:The |This )/.test(error.message) ? error.message : 'CareerForge could not read this résumé. Try pasting its text.';
    throw new HttpError(422, message);
  }
  throw new HttpError(415, 'Upload a PDF, DOCX, or plain text résumé.');
}

async function api(req, res, path) {
  const method = req.method;
  if (!['GET', 'HEAD'].includes(method)) requireSameOrigin(req);
  if (method === 'POST' && path === '/api/v1/auth/register') return authenticate(req, res, true);
  if (method === 'POST' && path === '/api/v1/auth/login') return authenticate(req, res, false);
  if (method === 'POST' && path === '/api/v1/auth/logout') {
    const token = readCookie(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return reply(res, 200, { user: null }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  const user = userFor(req);
  if (method === 'GET' && path === '/api/v1/auth/session') return reply(res, 200, { user });
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  if (method === 'DELETE' && path === '/api/v1/account') {
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    return reply(res, 200, { user: null }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (method === 'GET' && path === '/api/v1/state') {
    const row = db.prepare('SELECT state FROM workspaces WHERE user_id = ?').get(user.id);
    return reply(res, 200, { state: row ? JSON.parse(row.state) : null });
  }
  if (method === 'PUT' && path === '/api/v1/state') {
    const { state } = await readJson(req, stateLimit);
    if (!validWorkspace(state)) throw new HttpError(400, 'The workspace data has an invalid format.');
    db.prepare(`INSERT INTO workspaces VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`).run(user.id, JSON.stringify(state), Date.now());
    return reply(res, 200, { state });
  }
  if (method === 'POST' && path === '/api/v1/profile/resume-import') return importResume(req, res, user);
  if (method === 'POST' && path === '/api/v1/opportunities/extract') {
    rateLimit(`extract:${user.id}`, 10, 60_000);
    const { url } = await readJson(req);
    if (typeof url !== 'string' || url.length > 2048) throw new HttpError(400, 'Enter a public HTTPS listing URL.');
    try {
      return reply(res, 200, await extractOpportunity(url.trim()));
    } catch (error) {
      throw new HttpError(422, error.message);
    }
  }
  throw new HttpError(404, 'This API route does not exist.');
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function asset(req, res, path) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'This method is not supported.');
  const decoded = decodeURIComponent(path);
  const file = resolve(dist, decoded === '/' ? 'index.html' : `.${decoded}`);
  if (!file.startsWith(`${dist}${sep}`) || !Object.hasOwn(contentTypes, extname(file))) throw new HttpError(404, 'Page not found.');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, 'Page not found.');
  res.writeHead(200, { ...securityHeaders, 'Content-Type': contentTypes[extname(file)], 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

export async function handleRequest(req, res) {
  try {
    const host = req.headers.host;
    if (!/^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/i.test(host ?? '')) throw new HttpError(403, 'Open CareerForge on localhost.');
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path.startsWith('/api/')) await api(req, res, path);
    else await asset(req, res, path);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    if (error instanceof HttpError) return reply(res, error.status, { error: error.message });
    if (error instanceof URIError) return reply(res, 400, { error: 'Invalid request path.' });
    console.error('CareerForge request failed:', error.code ?? error.name);
    return reply(res, 500, { error: 'CareerForge could not finish the request. Please try again.' });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createServer(handleRequest);
  server.listen(port, '127.0.0.1', () => {
    console.log(`CareerForge is running at http://127.0.0.1:${server.address().port}`);
  });
}
