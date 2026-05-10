/**
 * Single-user free/busy: given a list of time windows, return a parallel
 * array of booleans saying whether the user has any non-transparent event
 * that overlaps each window. Used by the public poll endpoint to mark each
 * candidate slot busy or free for a signed-in respondent.
 *
 * Mirrors the architecture of group-events.mjs: parallel listEvents() calls
 * with a per-call timeout, results merged into a flat list, then each
 * window's overlap evaluated locally. KV-cached for 30s by (userId,
 * windowsHash) so flipping back to the poll page in quick succession reuses
 * one fetch.
 */

import { createHash } from "node:crypto";
import { getDb } from "../db/client.mjs";
import { getProviderClientForCalendar } from "./providers/index.mjs";
import { kvGet, kvSet } from "./kv-cache.mjs";

const CACHE_TTL_MS = 30 * 1000;
const PROVIDER_LIST_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`${label} timed out after ${ms}ms`), {
            statusCode: 504,
          }),
        ),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function cacheKeyFor(userId, windows) {
  // Stable hash over the sorted window edges so reloading the same page
  // (same options) hits cache; rearranging or editing windows misses.
  const sig = windows
    .map((w) => `${w.start_ms}-${w.end_ms}`)
    .sort()
    .join("|");
  const h = createHash("sha256")
    .update(`${userId}|${sig}`)
    .digest("hex")
    .slice(0, 32);
  return `ua:${h}`;
}

/**
 * @param {object} args
 * @param {string} args.userId — the signed-in viewer
 * @param {Array<{ start_ms: number, end_ms: number }>} args.windows — per
 *   poll option. Order is preserved in the output.
 * @param {Function} [args.getProviderClient] — test injection point.
 * @returns {Promise<boolean[]>} — busy flag aligned with `windows`.
 */
export async function freeBusyForUser({
  userId,
  windows,
  getProviderClient = getProviderClientForCalendar,
}) {
  if (!Array.isArray(windows) || windows.length === 0) return [];

  const cacheable = getProviderClient === getProviderClientForCalendar;
  const key = cacheable ? cacheKeyFor(userId, windows) : null;
  if (key) {
    const hit = await kvGet(key);
    if (hit && Array.isArray(hit) && hit.length === windows.length) return hit;
  }

  const db = getDb();
  // Use enabled, non-ICS calendars where we hold OAuth credentials. ICS feeds
  // could in principle contribute too, but they're read-only and used less by
  // the kind of user who's responding to a meeting poll — skip for v1 to keep
  // the latency budget tight. Calendars belong to a user via the
  // oauth_accounts table (calendars.tenant_id is the workspace, oauth_accounts
  // .user_id is the actual person who granted the OAuth).
  const calsRes = await db.execute({
    sql: `SELECT c.id, c.provider, c.provider_calendar_id, c.oauth_account_id,
                 c.ics_url_enc, c.tenant_id
            FROM calendars c
            JOIN oauth_accounts oa ON oa.id = c.oauth_account_id
           WHERE oa.user_id = ?
             AND c.enabled = 1
             AND c.provider IN ('google','microsoft')`,
    args: [userId],
  });

  if (calsRes.rows.length === 0) {
    // No connected calendars → no busy info. Treat all options as unknown
    // (returned as `false`, but the caller can choose to interpret missing
    // signal differently if it ever needs to).
    const out = new Array(windows.length).fill(false);
    if (key) kvSet(key, out, CACHE_TTL_MS).catch(() => {});
    return out;
  }

  // Envelope spanning all windows. Each calendar gets one listEvents call
  // for the whole envelope; we filter per-window in memory.
  const envelopeStart = Math.min(...windows.map((w) => w.start_ms));
  const envelopeEnd = Math.max(...windows.map((w) => w.end_ms));
  const timeMin = new Date(envelopeStart).toISOString();
  const timeMax = new Date(envelopeEnd).toISOString();

  const fetches = calsRes.rows.map(async (row) => {
    try {
      const client = await getProviderClient({
        id: row.id,
        provider: row.provider,
        provider_calendar_id: row.provider_calendar_id,
        oauth_account_id: row.oauth_account_id,
        ics_url_enc: row.ics_url_enc,
        tenant_id: row.tenant_id,
      });
      const events = await withTimeout(
        client.listEvents(row.provider_calendar_id, timeMin, timeMax),
        PROVIDER_LIST_TIMEOUT_MS,
        `listEvents(${row.provider})`,
      );
      return events;
    } catch {
      // A single-calendar failure shouldn't blank the whole pre-check.
      // Returning [] effectively says "no known busy" for that calendar.
      return [];
    }
  });

  const eventLists = await Promise.all(fetches);
  const allEvents = eventLists.flat();

  // For each window, find any non-transparent event that overlaps. Once we
  // find one, the window is busy — no need to keep scanning that window.
  //
  // Known limitation (shared with lib/group-events.mjs): we don't yet skip
  // events the viewer has declined. The provider normalization in
  // lib/google.mjs and lib/microsoft.mjs doesn't currently surface the
  // per-attendee responseStatus, so we treat any non-transparent event as
  // busy. Fix requires extending those modules and is tracked separately.
  const out = windows.map((w) => {
    for (const e of allEvents) {
      if (e.transparency === "transparent") continue;
      const eStart = e.start?.dateTime
        ? Date.parse(e.start.dateTime)
        : e.start?.date
          ? Date.parse(`${e.start.date}T00:00:00Z`)
          : null;
      const eEnd = e.end?.dateTime
        ? Date.parse(e.end.dateTime)
        : e.end?.date
          ? Date.parse(`${e.end.date}T00:00:00Z`)
          : null;
      if (eStart == null || eEnd == null) continue;
      if (eStart < w.end_ms && eEnd > w.start_ms) return true;
    }
    return false;
  });

  if (key) kvSet(key, out, CACHE_TTL_MS).catch(() => {});
  return out;
}
