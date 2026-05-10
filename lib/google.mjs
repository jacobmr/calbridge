import { getDb } from "../db/client.mjs";
import { encrypt, decrypt } from "./crypto.mjs";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";

function calendarEventsUrl(calendarId) {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

export async function listGoogleEvents(
  accessToken,
  calendarId,
  timeMin,
  timeMax,
) {
  const url = new URL(calendarEventsUrl(calendarId));
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`list events failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }

  const data = await res.json();
  return (data.items || []).map((item) => ({
    id: item.id,
    summary: item.summary,
    description: item.description,
    start: item.start,
    end: item.end,
    location: item.location,
    transparency: item.transparency,
    visibility: item.visibility,
  }));
}

export async function createGoogleEvent(accessToken, calendarId, event) {
  // If the event payload contains conferenceData (Google Meet auto-attach),
  // we MUST set conferenceDataVersion=1 on the URL — Google silently drops
  // conference data otherwise. No-op for plain events.
  const url = new URL(calendarEventsUrl(calendarId));
  if (event.conferenceData) {
    url.searchParams.set("conferenceDataVersion", "1");
  }
  // sendUpdates=all sends invite emails to attendees on the host's behalf —
  // exactly what a booker expects when they fill in their email.
  if (event.attendees && event.attendees.length) {
    url.searchParams.set("sendUpdates", "all");
  }
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`create event failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }

  return res.json();
}

export async function updateGoogleEvent(
  accessToken,
  calendarId,
  eventId,
  patch,
) {
  const url = `${calendarEventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`update event failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }
  return res.json();
}

export async function deleteGoogleEvent(accessToken, calendarId, eventId) {
  const url = `${calendarEventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 200/204 = success; 410 = already gone (treat as success)
  if (!res.ok && res.status !== 410) {
    const text = await res.text();
    const err = new Error(`delete event failed: ${text}`);
    err.statusCode = 502;
    throw err;
  }
}

export async function refreshAccessToken(refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
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
 * List the user's Google contacts via the People API.
 *
 * Returns a normalized [{ name, email }] list, deduplicated by email. The
 * `pageSize` is the max per response page; we walk pages until exhausted or
 * we hit a hard cap. Google's People API caps at 1000 per page.
 *
 * Requires the contacts.readonly scope on the access token.
 */
const PEOPLE_API_URL = "https://people.googleapis.com/v1/people/me/connections";
const OTHER_CONTACTS_API_URL = "https://people.googleapis.com/v1/otherContacts";

/**
 * List the user's "Other contacts" — Google's auto-collected list of people
 * they've emailed from Gmail. Separate scope (contacts.other.readonly), and
 * separate endpoint, but the response shape is the same as connections.
 *
 * For most users this is the long tail of "people I actually correspond
 * with" — formal contacts only captures the small subset of people they've
 * explicitly added.
 */
export async function listGoogleOtherContacts(
  accessToken,
  { maxResults = 1000 } = {},
) {
  const out = [];
  const seenEmails = new Set();
  let pageToken = "";
  while (out.length < maxResults) {
    const url = new URL(OTHER_CONTACTS_API_URL);
    // Only certain fields are supported on otherContacts. names + emailAddresses
    // are the two we care about; per docs they're available without any extra
    // readSourceTypes setting.
    url.searchParams.set("readMask", "names,emailAddresses");
    url.searchParams.set(
      "pageSize",
      String(Math.min(1000, maxResults - out.length)),
    );
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`list other-contacts failed: ${text}`);
      err.statusCode = 502;
      throw err;
    }
    const data = await res.json();
    for (const c of data.otherContacts || []) {
      const name = (c.names && c.names[0]?.displayName) || null;
      for (const e of c.emailAddresses || []) {
        const email = (e.value || "").trim().toLowerCase();
        if (!email || seenEmails.has(email)) continue;
        seenEmails.add(email);
        out.push({ name, email });
        if (out.length >= maxResults) break;
      }
      if (out.length >= maxResults) break;
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return out;
}

export async function listGoogleContacts(
  accessToken,
  { maxResults = 1000 } = {},
) {
  const out = [];
  const seenEmails = new Set();
  let pageToken = "";
  while (out.length < maxResults) {
    const url = new URL(PEOPLE_API_URL);
    url.searchParams.set("personFields", "names,emailAddresses");
    url.searchParams.set(
      "pageSize",
      String(Math.min(1000, maxResults - out.length)),
    );
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`list contacts failed: ${text}`);
      err.statusCode = 502;
      throw err;
    }
    const data = await res.json();
    for (const c of data.connections || []) {
      // A single contact can have multiple emails (home, work, …). Emit
      // each as its own suggestion so the user picks the right one — and
      // dedupe on the lowercased address so duplicates across pages or
      // across name fields collapse.
      const name = (c.names && c.names[0]?.displayName) || null;
      for (const e of c.emailAddresses || []) {
        const email = (e.value || "").trim().toLowerCase();
        if (!email || seenEmails.has(email)) continue;
        seenEmails.add(email);
        out.push({ name, email });
        if (out.length >= maxResults) break;
      }
      if (out.length >= maxResults) break;
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return out;
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
