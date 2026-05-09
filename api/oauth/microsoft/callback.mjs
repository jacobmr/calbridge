import { randomUUID } from 'node:crypto';
import { getDb } from '../../../db/client.mjs';
import { encrypt } from '../../../lib/crypto.mjs';
import { createSession, setSessionCookie } from '../../../lib/session.mjs';

const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_USERINFO_URL = 'https://graph.microsoft.com/v1.0/me';

function makeSlug(email) {
  const base = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'user';
}

async function ensureUniqueSlug(db, baseSlug) {
  let slug = baseSlug;
  let counter = 1;
  while (true) {
    const existing = await db.execute({
      sql: 'SELECT 1 FROM tenants WHERE slug = ?',
      args: [slug],
    });
    if (!existing.rows[0]) return slug;
    slug = `${baseSlug}-${counter++}`;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const baseUrl = process.env.APP_BASE_URL || 'https://mical.net';
  const url = new URL(req.url, baseUrl);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'OAuth denied', detail: error }));
    return;
  }

  if (!code || !state) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'missing code or state' }));
    return;
  }

  const db = getDb();

  // Verify state
  const stateRow = await db.execute({
    sql: 'SELECT id, intent, provider, tenant_id, return_to, expires_at FROM oauth_states WHERE id = ?',
    args: [state],
  });
  const stateRec = stateRow.rows[0];
  if (!stateRec || Number(stateRec.expires_at) < Date.now()) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid or expired state' }));
    return;
  }

  // Exchange code for tokens
  const tokenRes = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      redirect_uri: process.env.MS_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'token exchange failed', detail: text }));
    return;
  }

  const tokens = await tokenRes.json();

  // Get user info
  const userRes = await fetch(MICROSOFT_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    const text = await userRes.text();
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'userinfo fetch failed', detail: text }));
    return;
  }

  const microsoftUser = await userRes.json();

  const now = Date.now();
  const providerAccountId = microsoftUser.id;
  const email = microsoftUser.mail || microsoftUser.userPrincipalName || '';
  const displayName = microsoftUser.displayName || email;

  // Check if oauth_account already exists for this Microsoft account
  const existingAcct = await db.execute({
    sql: 'SELECT id, tenant_id, user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?',
    args: ['microsoft', providerAccountId],
  });

  let userId;
  let tenantId;

  if (existingAcct.rows[0]) {
    // Update existing account — preserve old refresh_token if Microsoft didn't send a new one
    userId = existingAcct.rows[0].user_id;
    tenantId = existingAcct.rows[0].tenant_id;

    const refreshToken = tokens.refresh_token
      ? encrypt(tokens.refresh_token)
      : undefined;
    const accessToken = tokens.access_token ? encrypt(tokens.access_token) : null;
    const accessTokenExpires = tokens.expires_in ? now + tokens.expires_in * 1000 : null;

    if (refreshToken) {
      await db.execute({
        sql: 'UPDATE oauth_accounts SET refresh_token_enc = ?, access_token_enc = ?, access_token_expires_at = ?, scopes = ?, raw_json = ?, email = ? WHERE id = ?',
        args: [
          refreshToken,
          accessToken,
          accessTokenExpires,
          tokens.scope || '',
          JSON.stringify(microsoftUser),
          email,
          existingAcct.rows[0].id,
        ],
      });
    } else {
      await db.execute({
        sql: 'UPDATE oauth_accounts SET access_token_enc = ?, access_token_expires_at = ?, scopes = ?, raw_json = ?, email = ? WHERE id = ?',
        args: [
          accessToken,
          accessTokenExpires,
          tokens.scope || '',
          JSON.stringify(microsoftUser),
          email,
          existingAcct.rows[0].id,
        ],
      });
    }
  } else {
    // New Microsoft account — see if user already exists by email
    const existingUser = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [email],
    });

    if (existingUser.rows[0]) {
      userId = existingUser.rows[0].id;
      const userTenant = await db.execute({
        sql: 'SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1',
        args: [userId],
      });
      tenantId = userTenant.rows[0]?.id;

      if (!tenantId) {
        // User exists but has no tenant — create one
        tenantId = randomUUID();
        const slug = await ensureUniqueSlug(db, makeSlug(email));
        await db.execute({
          sql: 'INSERT INTO tenants (id, slug, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)',
          args: [tenantId, slug, displayName || email, userId, now],
        });
      }
    } else {
      // Brand new user + tenant
      userId = randomUUID();
      await db.execute({
        sql: 'INSERT INTO users (id, email, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        args: [userId, email, displayName, now, now],
      });

      tenantId = randomUUID();
      const slug = await ensureUniqueSlug(db, makeSlug(email));
      await db.execute({
        sql: 'INSERT INTO tenants (id, slug, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [tenantId, slug, displayName || email, userId, now],
      });
    }

    // Create oauth_account
    const acctId = randomUUID();
    await db.execute({
      sql: `INSERT INTO oauth_accounts
        (id, tenant_id, user_id, provider, provider_account_id, email,
         refresh_token_enc, access_token_enc, access_token_expires_at, scopes, raw_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        acctId,
        tenantId,
        userId,
        'microsoft',
        providerAccountId,
        email,
        encrypt(tokens.refresh_token || ''),
        tokens.access_token ? encrypt(tokens.access_token) : null,
        tokens.expires_in ? now + tokens.expires_in * 1000 : null,
        tokens.scope || '',
        JSON.stringify(microsoftUser),
        now,
      ],
    });
  }

  // Update last_seen
  await db.execute({
    sql: 'UPDATE users SET last_seen_at = ? WHERE id = ?',
    args: [now, userId],
  }).catch(() => {});

  // Clean up state
  await db.execute({
    sql: 'DELETE FROM oauth_states WHERE id = ?',
    args: [state],
  }).catch(() => {});

  // Create session
  const sessionId = await createSession(userId);
  setSessionCookie(res, sessionId);

  // Redirect
  const returnTo = stateRec.return_to || '/';
  res.statusCode = 302;
  res.setHeader('location', returnTo);
  res.end();
}
