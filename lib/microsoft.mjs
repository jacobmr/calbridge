import { getDb } from "../db/client.mjs";
import { encrypt, decrypt } from "./crypto.mjs";

const MS_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export async function refreshMicrosoftAccessToken(refreshToken) {
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope:
        "openid email profile offline_access Calendars.Read Calendars.ReadWrite",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Microsoft token refresh failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }

  return res.json();
}

export async function getValidMicrosoftAccessToken(oauthAccountRow) {
  const now = Date.now();
  const expiresAt = oauthAccountRow.access_token_expires_at
    ? Number(oauthAccountRow.access_token_expires_at)
    : 0;

  if (expiresAt > now + 60000 && oauthAccountRow.access_token_enc) {
    return decrypt(oauthAccountRow.access_token_enc);
  }

  const refreshToken = decrypt(oauthAccountRow.refresh_token_enc);
  const tokens = await refreshMicrosoftAccessToken(refreshToken);

  const newAccessToken = tokens.access_token;
  const newExpiresAt = tokens.expires_in
    ? now + tokens.expires_in * 1000
    : null;

  const db = getDb();
  await db.execute({
    sql: "UPDATE oauth_accounts SET access_token_enc = ?, access_token_expires_at = ? WHERE id = ?",
    args: [encrypt(newAccessToken), newExpiresAt, oauthAccountRow.id],
  });

  return newAccessToken;
}

export async function listMicrosoftCalendars(accessToken) {
  const res = await fetch(`${MS_GRAPH_BASE}/me/calendars`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Microsoft calendar list failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }

  const data = await res.json();
  return (data.value || []).map((item) => ({
    id: item.id,
    summary: item.name,
    description: "",
    primary: item.isDefaultCalendar || false,
    accessRole: "owner",
  }));
}

export async function listMicrosoftEvents(
  accessToken,
  calendarId,
  startDateTime,
  endDateTime,
) {
  const url = new URL(
    `${MS_GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/calendarView`,
  );
  url.searchParams.set("startDateTime", startDateTime);
  url.searchParams.set("endDateTime", endDateTime);
  url.searchParams.set(
    "$select",
    "id,subject,body,start,end,location,showAs,sensitivity,isAllDay",
  );

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Microsoft list events failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }

  const data = await res.json();
  return (data.value || []).map((item) => ({
    id: item.id,
    summary: item.subject,
    description: item.body?.content || "",
    start: item.start,
    end: item.end,
    location: item.location?.displayName || "",
    transparency: item.showAs === "free" ? "transparent" : "opaque",
    visibility: item.sensitivity === "private" ? "private" : "default",
  }));
}

export async function createMicrosoftEvent(accessToken, calendarId, event) {
  const res = await fetch(
    `${MS_GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Microsoft create event failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }

  return res.json();
}

export async function updateMicrosoftEvent(accessToken, calendarId, eventId, patch) {
  // MS Graph: events are addressable via /me/events/{id} regardless of calendar
  const res = await fetch(
    `${MS_GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Microsoft update event failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }
  return res.json();
}

export async function deleteMicrosoftEvent(accessToken, calendarId, eventId) {
  const res = await fetch(
    `${MS_GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    const err = new Error(`Microsoft delete event failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }
}
