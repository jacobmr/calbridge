import { getDb } from '../db/client.mjs';
import { encrypt, decrypt } from './crypto.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

export async function refreshAccessToken(refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`token refresh failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }

  return res.json();
}

export async function getValidAccessToken(oauthAccountRow) {
  const now = Date.now();
  const expiresAt = oauthAccountRow.access_token_expires_at
    ? Number(oauthAccountRow.access_token_expires_at)
    : 0;

  if (expiresAt > now + 60000 && oauthAccountRow.access_token_enc) {
    return decrypt(oauthAccountRow.access_token_enc);
  }

  const refreshToken = decrypt(oauthAccountRow.refresh_token_enc);
  const tokens = await refreshAccessToken(refreshToken);

  const newAccessToken = tokens.access_token;
  const newExpiresAt = tokens.expires_in ? now + tokens.expires_in * 1000 : null;

  const db = getDb();
  await db.execute({
    sql: 'UPDATE oauth_accounts SET access_token_enc = ?, access_token_expires_at = ? WHERE id = ?',
    args: [encrypt(newAccessToken), newExpiresAt, oauthAccountRow.id],
  });

  return newAccessToken;
}

export async function listGoogleCalendars(accessToken) {
  const res = await fetch(GOOGLE_CALENDAR_LIST_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`calendar list failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }

  const data = await res.json();
  return (data.items || []).map((item) => ({
    id: item.id,
    summary: item.summary,
    description: item.description,
    primary: item.primary || false,
    accessRole: item.accessRole,
  }));
}
