import { randomBytes } from 'node:crypto';
import { getDb } from '../../../db/client.mjs';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

function randomState() {
  return randomBytes(32).toString('base64url');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const baseUrl = process.env.APP_BASE_URL;

  if (!clientId || !redirectUri) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'OAuth not configured' }));
    return;
  }

  const url = new URL(req.url, baseUrl);
  const returnTo = url.searchParams.get('return_to') || '/app/';
  const tenantId = url.searchParams.get('tenant_id') || null;

  const state = randomState();
  const db = getDb();
  const now = Date.now();
  await db.execute({
    sql: 'INSERT INTO oauth_states (id, intent, provider, tenant_id, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [state, 'link', 'google', tenantId, returnTo, now, now + 10 * 60 * 1000],
  });

  const scopes = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ];

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  res.statusCode = 302;
  res.setHeader('location', authUrl.toString());
  res.end();
}
