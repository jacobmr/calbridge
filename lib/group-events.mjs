/**
 * Aggregates events across a group's members, applying the sharer's
 * share_level and the receiver's receive_level. Used by:
 *   - GET /api/groups/:id/events       (merged calendar view)
 *   - GET /api/groups/:id/availability (ask-the-family)
 *
 * Effective visibility rules:
 *   The narrower of share_level (the sharer's exposure choice) and
 *   receive_level (the receiver's preference) wins. Order narrowest first:
 *     none < free_busy < full
 *   So if Alice shares full but Bob asked free_busy, Bob sees free/busy.
 *
 * For free/busy, we strip summary/description/location and mark the event
 * as a generic busy block. The originating member is always identified
 * (so the merged view can color-code), but their event titles never leak
 * past their share_level.
 */

import { getDb } from "../db/client.mjs";
import { getProviderClientForCalendar } from "./providers/index.mjs";

const LEVEL_RANK = { none: 0, free_busy: 1, full: 2 };

/** Pick the narrower of two levels by rank. */
function effectiveLevel(shareLevel, receiveLevel) {
  const a = LEVEL_RANK[shareLevel] ?? LEVEL_RANK.full;
  const b = LEVEL_RANK[receiveLevel] ?? LEVEL_RANK.full;
  return a <= b ? shareLevel : receiveLevel;
}

/**
 * Fetch all events visible to `viewerUserId` within a group, between timeMin
 * and timeMax. Returns a flat, time-sorted list of normalized events tagged
 * with member metadata.
 *
 * @returns {Promise<Array<{
 *   sharer_user_id: string,
 *   sharer_display: string,
 *   sharer_email: string,
 *   calendar_id: string,
 *   calendar_label: string,
 *   id: string,
 *   summary: string|null,
 *   description: string|null,
 *   location: string|null,
 *   start: object,
 *   end: object,
 *   transparency: string|null,
 *   visibility: string|null,
 *   level: 'full'|'free_busy',
 * }>>}
 */
export async function fetchGroupEvents({
  groupId,
  viewerUserId,
  timeMin,
  timeMax,
  // Optional injection point for tests (mirrors the sync engine pattern).
  getProviderClient = getProviderClientForCalendar,
}) {
  const db = getDb();

  // 1. All non-'none' shares from active members other than viewer
  //    + receive_level the viewer has set for each sharer.
  const r = await db.execute({
    sql: `SELECT s.user_id        AS sharer_user_id,
                 s.calendar_id    AS calendar_id,
                 s.share_level    AS share_level,
                 c.label          AS calendar_label,
                 c.provider       AS calendar_provider,
                 c.provider_calendar_id AS provider_calendar_id,
                 c.oauth_account_id     AS oauth_account_id,
                 c.ics_url_enc          AS ics_url_enc,
                 c.tenant_id            AS tenant_id,
                 u.email          AS sharer_email,
                 u.display_name   AS sharer_display,
                 rs.receive_level AS receive_level
            FROM group_calendar_shares s
            JOIN group_memberships m
              ON m.group_id = s.group_id AND m.user_id = s.user_id
             AND m.status = 'active'
            JOIN calendars c ON c.id = s.calendar_id
            JOIN users u     ON u.id = s.user_id
            LEFT JOIN group_receive_settings rs
              ON rs.group_id = s.group_id
             AND rs.receiver_user_id = ?
             AND rs.sharer_user_id = s.user_id
           WHERE s.group_id = ?
             AND s.user_id != ?
             AND s.share_level != 'none'`,
    args: [viewerUserId, groupId, viewerUserId],
  });

  // Group rows by calendar so we make exactly one provider call per calendar.
  const byCal = new Map();
  for (const row of r.rows) {
    const level = effectiveLevel(row.share_level, row.receive_level || "full");
    if (level === "none") continue;
    byCal.set(row.calendar_id, {
      ...row,
      level,
      calendarRow: {
        id: row.calendar_id,
        provider: row.calendar_provider,
        provider_calendar_id: row.provider_calendar_id,
        oauth_account_id: row.oauth_account_id,
        ics_url_enc: row.ics_url_enc,
        tenant_id: row.tenant_id,
      },
    });
  }

  // Fetch in parallel; one slow calendar should never delay the others.
  const fetches = [...byCal.values()].map(async (entry) => {
    try {
      const client = await getProviderClient(entry.calendarRow);
      const providerCalId =
        entry.calendar_provider === "ics"
          ? "ics-feed"
          : entry.provider_calendar_id;
      const events = await client.listEvents(providerCalId, timeMin, timeMax);
      return { entry, events };
    } catch (e) {
      // Individual calendar failures shouldn't blank the whole view —
      // we'll surface the issue separately if needed.
      return { entry, events: [], error: e.message };
    }
  });
  const results = await Promise.all(fetches);

  const out = [];
  for (const { entry, events } of results) {
    for (const evt of events) {
      const isBusyOnly = entry.level === "free_busy";
      out.push({
        sharer_user_id: entry.sharer_user_id,
        sharer_display: entry.sharer_display || entry.sharer_email,
        sharer_email: entry.sharer_email,
        calendar_id: entry.calendar_id,
        calendar_label: entry.calendar_label,
        id: evt.id,
        // For free/busy, deliberately drop title/desc/location.
        summary: isBusyOnly ? null : evt.summary || null,
        description: isBusyOnly ? null : evt.description || null,
        location: isBusyOnly ? null : evt.location || null,
        start: evt.start,
        end: evt.end,
        transparency: evt.transparency || null,
        visibility: evt.visibility || null,
        level: entry.level,
      });
    }
  }

  // Sort newest-first relative to start time. Use ms epoch from either
  // dateTime or date, defaulting to 0 for malformed entries (will land
  // at top — we'd rather surface broken events than hide them).
  function startMs(e) {
    if (e.start?.dateTime) return Date.parse(e.start.dateTime) || 0;
    if (e.start?.date) return Date.parse(`${e.start.date}T00:00:00Z`) || 0;
    return 0;
  }
  out.sort((a, b) => startMs(a) - startMs(b));
  return out;
}

/**
 * Compute whether the time range [windowStart, windowEnd] has any conflict
 * across the group. Returns the conflicting events (each tagged with the
 * sharer) and a per-member free/busy summary.
 *
 * Free/busy semantics: an event is treated as "busy" unless its
 * transparency is 'transparent' (Google "free" / MS "free"). Free-busy
 * shares still produce conflicts — that's the whole point.
 */
export async function computeGroupAvailability({
  groupId,
  viewerUserId,
  windowStart,
  windowEnd,
  getProviderClient,
}) {
  const events = await fetchGroupEvents({
    groupId,
    viewerUserId,
    timeMin: windowStart,
    timeMax: windowEnd,
    getProviderClient,
  });

  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  const conflicts = [];
  const busyByMember = new Map(); // sharer_user_id -> bool

  for (const e of events) {
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
    // Overlap test
    if (eStart < endMs && eEnd > startMs) {
      conflicts.push(e);
      busyByMember.set(e.sharer_user_id, true);
    }
  }

  return {
    free: conflicts.length === 0,
    conflicts,
    busyMemberIds: [...busyByMember.keys()],
  };
}
