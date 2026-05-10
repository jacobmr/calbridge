import { getDb } from "../db/client.mjs";
import { encrypt, decrypt } from "./crypto.mjs";

const MS_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export async function refreshMicrosoftAccessToken(refreshToken) {
  // Omit the `scope` param on refresh: Microsoft returns whatever scopes
  // the refresh_token was originally granted. Hardcoding a specific scope
  // string breaks any user whose original consent didn't match (e.g.
  // pre-existing users when we add a new scope like Contacts.Read), and
  // there's no upside — sending a subset would just shrink the access
  // token, sending a superset is rejected.
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
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

/**
 * List Microsoft contacts via Graph API (/me/contacts). Returns a
 * normalized [{ name, email }] list, deduplicated by lowercased email.
 *
 * Graph paginates with @odata.nextLink — a fully-qualified URL we just
 * follow as-is. Capped by maxResults to avoid pathological accounts.
 *
 * Requires the Contacts.Read scope.
 */
export async function listMicrosoftContacts(
  accessToken,
  { maxResults = 1000 } = {},
) {
  const out = [];
  const seenEmails = new Set();
  let url = new URL(`${MS_GRAPH_BASE}/me/contacts`);
  url.searchParams.set("$select", "displayName,emailAddresses");
  url.searchParams.set("$top", "100");
  let nextLink = url.toString();
  while (nextLink && out.length < maxResults) {
    const res = await fetch(nextLink, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Microsoft contacts list failed: ${text}`);
      err.statusCode = 502;
      throw err;
    }
    const data = await res.json();
    for (const c of data.value || []) {
      const name = c.displayName || null;
      for (const e of c.emailAddresses || []) {
        const email = (e.address || "").trim().toLowerCase();
        if (!email || seenEmails.has(email)) continue;
        seenEmails.add(email);
        out.push({ name, email });
        if (out.length >= maxResults) break;
      }
      if (out.length >= maxResults) break;
    }
    nextLink = data["@odata.nextLink"] || null;
  }
  return out;
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

export async function updateMicrosoftEvent(
  accessToken,
  calendarId,
  eventId,
  patch,
) {
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
