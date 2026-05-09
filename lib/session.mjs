import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/client.mjs';

const COOKIE_NAME = 'cb_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function loadSigningKey() {
  const b64 = process.env.SESSION_SIGNING_KEY;
  if (!b64) throw new Error('SESSION_SIGNING_KEY not set');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) throw new Error('SESSION_SIGNING_KEY must decode to 32 bytes');
  return buf;
}

function sign(id, key) {
  return createHmac('sha256', key).update(id).digest('base64url');
}

export function buildCookieValue(id) {
  return `${id}.${sign(id, loadSigningKey())}`;
}

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function readSessionCookie(req) {
  const cookies = parseCookieHeader(req.headers?.cookie || '');
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(id, loadSigningKey());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return id;
}

export function setSessionCookie(res, id, { maxAgeMs = SESSION_TTL_MS } = {}) {
  const value = buildCookieValue(id);
  const maxAge = Math.floor(maxAgeMs / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

export function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );
}

export function newSessionId() {
  return randomBytes(24).toString('base64url');
}

export async function createSession(userId, { ttlMs = SESSION_TTL_MS } = {}) {
  const id = newSessionId();
  const now = Date.now();
  const db = getDb();
  await db.execute({
    sql: 'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
    args: [id, userId, now, now + ttlMs, now],
  });
  return id;
}

export async function loadSession(req) {
  const id = readSessionCookie(req);
  if (!id) return null;
  const db = getDb();
  const r = await db.execute({
    sql: 'SELECT id, user_id, expires_at FROM sessions WHERE id = ?',
    args: [id],
  });
  const row = r.rows[0];
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) return null;
  db.execute({
    sql: 'UPDATE sessions SET last_used_at = ? WHERE id = ?',
    args: [Date.now(), id],
  }).catch(() => {});
  return { sessionId: row.id, userId: row.user_id };
}

export async function destroySession(req) {
  const id = readSessionCookie(req);
  if (!id) return;
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [id] });
}

export async function requireUser(req) {
  const session = await loadSession(req);
  if (!session) {
    const err = new Error('unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const db = getDb();
  const r = await db.execute({
    sql: 'SELECT id, email, display_name FROM users WHERE id = ?',
    args: [session.userId],
  });
  const user = r.rows[0];
  if (!user) {
    const err = new Error('unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return { user, sessionId: session.sessionId };
}
