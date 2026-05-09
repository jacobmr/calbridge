import { randomBytes } from 'node:crypto';
import { getDb } from '../../../db/client.mjs';

const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

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

  const clientId = process.env.MS_CLIENT_ID;
  const redirectUri = process.env.MS_REDIRECT_URI;
  const baseUrl = process.env.APP_BASE_URL;

  if (!clientId || !redirectUri) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'OAuth not configured' }));
    return;
  }

  const url = new URL(req.url, baseUrl);
  const returnTo = url.searchParams.get('return_to') || '/';
  const tenantId = url.searchParams.get('tenant_id') || null;

  const state = randomState();
  const db = getDb();
  const now = Date.now();
  await db.execute({
    sql: 'INSERT INTO oauth_states (id, intent, provider, tenant_id, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [state, 'link', 'microsoft', tenantId, returnTo, now, now + 10 * 60 * 1000],
  });

  const scopes = [
    'openid',
    'email',
    'profile',
    'offline_access',
    'Calendars.Read',
    'Calendars.ReadWrite',
  ];

  const authUrl = new URL(MICROSOFT_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'consent');

  res.statusCode = 302;
  res.setHeader('location', authUrl.toString());
  res.end();
}
