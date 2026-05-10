/**
 * GET /api/polls/host-availability?start=ISO&end=ISO
 *
 * Returns the calling user's busy intervals across all enabled, non-ICS
 * calendars in the requested window. Used by the poll-create slot picker
 * to gray out times that already conflict with the organizer's calendar.
 *
 * Output: { busy: [{ start_ms, end_ms }] } sorted by start_ms.
 *
 * Auth: session-cookie required. The endpoint reveals only the calling
 * user's own busy times — it has no notion of "host slug" or other users.
 */

import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { sendError } from "../../lib/groups.mjs";
import { getProviderClientForCalendar } from "../../lib/providers/index.mjs";

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

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const { user } = await requireUser(req);

    const url = new URL(req.url, "http://localhost");
    const startISO = url.searchParams.get("start");
    const endISO = url.searchParams.get("end");
    if (!startISO || !endISO) {
      return sendError(
        res,
        Object.assign(new Error("start and end (ISO) are required"), {
          statusCode: 400,
        }),
      );
    }
    const startMs = Date.parse(startISO);
    const endMs = Date.parse(endISO);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      return sendError(
        res,
        Object.assign(new Error("invalid start/end"), { statusCode: 400 }),
      );
    }
    // Cap the window so a malformed client can't ask us to fetch a year of
    // events from every calendar.
    if (endMs - startMs > 90 * 24 * 60 * 60 * 1000) {
      return sendError(
        res,
        Object.assign(new Error("window too large (max 90 days)"), {
          statusCode: 400,
        }),
      );
    }

    const db = getDb();
    const calsRes = await db.execute({
      sql: `SELECT c.id, c.provider, c.provider_calendar_id, c.oauth_account_id,
                   c.ics_url_enc, c.tenant_id
              FROM calendars c
              JOIN oauth_accounts oa ON oa.id = c.oauth_account_id
             WHERE oa.user_id = ?
               AND c.enabled = 1
               AND c.provider IN ('google','microsoft')`,
      args: [user.id],
    });

    if (calsRes.rows.length === 0) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ busy: [] }));
      return;
    }

    // Fan out across the user's calendars in parallel. Each individual
    // failure becomes an empty list rather than blowing up the whole call.
    const fetches = calsRes.rows.map(async (row) => {
      try {
        const client = await getProviderClientForCalendar({
          id: row.id,
          provider: row.provider,
          provider_calendar_id: row.provider_calendar_id,
          oauth_account_id: row.oauth_account_id,
          ics_url_enc: row.ics_url_enc,
          tenant_id: row.tenant_id,
        });
        return await withTimeout(
          client.listEvents(row.provider_calendar_id, startISO, endISO),
          PROVIDER_LIST_TIMEOUT_MS,
          `listEvents(${row.provider})`,
        );
      } catch (err) {
        console.error("host-availability per-calendar failure:", err.message);
        return [];
      }
    });

    const eventLists = await Promise.all(fetches);
    const busy = [];
    for (const events of eventLists) {
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
        // Trim to the requested window — both for clarity and so the client
        // doesn't have to guard against intervals that extend past the grid.
        const s = Math.max(eStart, startMs);
        const eMs = Math.min(eEnd, endMs);
        if (s < eMs) busy.push({ start_ms: s, end_ms: eMs });
      }
    }
    busy.sort((a, b) => a.start_ms - b.start_ms);

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ busy }));
  } catch (err) {
    sendError(res, err);
  }
}
