/**
 * GET /api/overview
 *
 * Aggregates the data needed for the dashboard Overview tab in a single
 * round-trip. Returns:
 *
 * {
 *   counts: { calendars, syncFlows, eventTypes, bookings, bookingsNew },
 *   syncHealth: { healthy, stale, warning, error, neverRun },
 *   recentActivity: Activity[],          // sync_runs + bookings, last 5
 *   needsAttention: AttentionItem[]      // flows that are stale or failed
 * }
 *
 * Health buckets per sync flow:
 *   healthy    — last run finished < 24h ago, ok=1
 *   stale      — last run 24h–7d ago, ok=1
 *   warning    — last run > 7d ago, OR last run had errors
 *   error      — last run had ok=0 (overrides warning if also old)
 *   neverRun   — flow exists, no runs yet
 *
 * No new schema needed — derives everything from sync_runs.
 */

import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function getTenantForUser(db, userId) {
  const r = await db.execute({
    sql: "SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1",
    args: [userId],
  });
  return r.rows[0] || null;
}

function classifyHealth(lastRunAt, lastRunOk, now) {
  if (lastRunAt == null) return "neverRun";
  if (lastRunOk === 0 || lastRunOk === false) return "error";
  const ageMs = now - Number(lastRunAt);
  if (ageMs < DAY) return "healthy";
  if (ageMs < 7 * DAY) return "stale";
  return "warning";
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  try {
    const { user } = await requireUser(req);
    const db = getDb();
    const tenant = await getTenantForUser(db, user.id);
    if (!tenant) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "tenant not found" }));
      return;
    }

    const now = Date.now();

    // Run all the cheap counts + the latest-run-per-flow query in parallel.
    const [
      calendarsR,
      flowsR,
      eventTypesR,
      bookingsR,
      flowHealthR,
      recentRunsR,
      recentBookingsR,
    ] = await Promise.all([
      db.execute({
        sql: "SELECT COUNT(*) AS n FROM calendars WHERE tenant_id = ? AND enabled = 1",
        args: [tenant.id],
      }),
      db.execute({
        sql: "SELECT COUNT(*) AS n FROM sync_flows WHERE tenant_id = ?",
        args: [tenant.id],
      }),
      db.execute({
        sql: "SELECT COUNT(*) AS n FROM event_types WHERE tenant_id = ?",
        args: [tenant.id],
      }),
      db.execute({
        sql: `SELECT COUNT(*) AS n,
                     SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS n_new
              FROM bookings
              WHERE tenant_id = ? AND status = 'confirmed'`,
        args: [now - 7 * DAY, tenant.id],
      }),
      // Latest run per flow + flow info for classification
      db.execute({
        sql: `SELECT sf.id           AS flow_id,
                     sf.enabled      AS enabled,
                     sc.label        AS source_label,
                     tc.label        AS target_label,
                     sr.started_at   AS started_at,
                     sr.finished_at  AS finished_at,
                     sr.ok           AS ok
              FROM sync_flows sf
              LEFT JOIN calendars sc ON sc.id = sf.source_calendar_id
              LEFT JOIN calendars tc ON tc.id = sf.target_calendar_id
              LEFT JOIN (
                SELECT sync_flow_id, started_at, finished_at, ok,
                       ROW_NUMBER() OVER (PARTITION BY sync_flow_id ORDER BY started_at DESC) AS rn
                FROM sync_runs
                WHERE sync_flow_id IS NOT NULL
              ) sr ON sr.sync_flow_id = sf.id AND sr.rn = 1
              WHERE sf.tenant_id = ?`,
        args: [tenant.id],
      }),
      db.execute({
        sql: `SELECT sr.id, sr.started_at, sr.finished_at, sr.ok, sr.totals_json,
                     sr.sync_flow_id,
                     sc.label AS source_label,
                     tc.label AS target_label
              FROM sync_runs sr
              LEFT JOIN sync_flows sf ON sf.id = sr.sync_flow_id
              LEFT JOIN calendars sc ON sc.id = sf.source_calendar_id
              LEFT JOIN calendars tc ON tc.id = sf.target_calendar_id
              WHERE sr.tenant_id = ?
              ORDER BY sr.started_at DESC
              LIMIT 5`,
        args: [tenant.id],
      }),
      db.execute({
        sql: `SELECT b.id, b.created_at, b.subject, b.start_ms, et.name AS event_type_name
              FROM bookings b
              LEFT JOIN event_types et ON et.id = b.event_type_id
              WHERE b.tenant_id = ? AND b.status = 'confirmed'
              ORDER BY b.created_at DESC
              LIMIT 5`,
        args: [tenant.id],
      }),
    ]);

    // Bucket flow health
    const syncHealth = {
      healthy: 0,
      stale: 0,
      warning: 0,
      error: 0,
      neverRun: 0,
    };
    const needsAttention = [];
    for (const row of flowHealthR.rows) {
      if (!row.enabled) continue;
      const bucket = classifyHealth(row.started_at, row.ok, now);
      syncHealth[bucket]++;
      if (bucket === "error" || bucket === "warning") {
        needsAttention.push({
          kind: "sync_flow",
          flowId: row.flow_id,
          severity: bucket,
          source: row.source_label,
          target: row.target_label,
          lastRunAt: row.started_at != null ? Number(row.started_at) : null,
        });
      }
    }

    // Merge runs + bookings into one activity stream, newest first
    const activity = [];
    for (const r of recentRunsR.rows) {
      let totals = null;
      try {
        totals = r.totals_json ? JSON.parse(r.totals_json) : null;
      } catch {
        /* ignore */
      }
      activity.push({
        kind: "sync_run",
        at: Number(r.started_at),
        ok: r.ok === 1,
        flowId: r.sync_flow_id,
        source: r.source_label,
        target: r.target_label,
        totals,
      });
    }
    for (const b of recentBookingsR.rows) {
      activity.push({
        kind: "booking",
        at: Number(b.created_at),
        subject: b.subject,
        eventTypeName: b.event_type_name,
        startMs: b.start_ms != null ? Number(b.start_ms) : null,
      });
    }
    activity.sort((a, b) => b.at - a.at);
    const recentActivity = activity.slice(0, 5);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        counts: {
          calendars: Number(calendarsR.rows[0]?.n || 0),
          syncFlows: Number(flowsR.rows[0]?.n || 0),
          eventTypes: Number(eventTypesR.rows[0]?.n || 0),
          bookings: Number(bookingsR.rows[0]?.n || 0),
          bookingsNew: Number(bookingsR.rows[0]?.n_new || 0),
        },
        syncHealth,
        recentActivity,
        needsAttention,
      }),
    );
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
}
