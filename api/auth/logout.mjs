import { destroySession, clearSessionCookie } from '../../lib/session.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  await destroySession(req);
  clearSessionCookie(res);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}
