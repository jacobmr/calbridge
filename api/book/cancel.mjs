/**
 * Public booking cancellation.
 *
 *   GET  /api/book/cancel?token=<t>   → look up booking (lets the cancel
 *                                       page show what's about to be canceled)
 *   POST /api/book/cancel             → body: { token } — actually cancel
 *
 * No auth — possession of the token is the auth (tokens are 16 random bytes,
 * unguessable, scoped to one booking). Rate-limited at the platform level
 * via Vercel; not enforced here.
 *
 * Idempotent: cancelling an already-cancelled booking returns 200 with
 * status='already_cancelled' rather than failing.
 */

import { getDb } from "../../db/client.mjs";
import { getProviderClientForCalendar } from "../../lib/providers/index.mjs";

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function lookupByToken(token) {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT b.id, b.status, b.start_ms, b.end_ms,
                 b.attendee_name, b.attendee_email, b.subject,
                 et.name AS event_type_name,
                 t.name AS tenant_name
            FROM bookings b
            JOIN event_types et ON et.id = b.event_type_id
            JOIN tenants t ON t.id = b.tenant_id
           WHERE b.cancel_token = ?
           LIMIT 1`,
    args: [token],
  });
  return r.rows[0] || null;
}

async function getHandler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  if (!token) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "token required" }));
    return;
  }
  const row = await lookupByToken(token);
  if (!row) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "booking not found" }));
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      status: row.status,
      start_ms: Number(row.start_ms),
      end_ms: Number(row.end_ms),
      event_type_name: row.event_type_name,
      attendee_name: row.attendee_name,
      attendee_email: row.attendee_email,
      subject: row.subject,
      tenant_name: row.tenant_name,
    }),
  );
}

async function postHandler(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const token = String(body.token || "").trim();
  if (!token) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "token required" }));
    return;
  }
  const row = await lookupByToken(token);
  if (!row) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "booking not found" }));
    return;
  }
  if (row.status === "cancelled") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, status: "already_cancelled" }));
    return;
  }
  const db = getDb();

  // Pull the booking + its target calendar so we can delete the matching
  // provider event too. If we don't, cancelling here leaves the meeting on
  // the host's calendar — they cancel via MiCal, then their attendee shows
  // up at the original time anyway. We treat provider-delete failure as
  // non-fatal; the booking row still flips to cancelled.
  const full = await db.execute({
    sql: `SELECT b.id, b.provider_event_id, b.event_type_id,
                 et.target_calendar_id
            FROM bookings b
            JOIN event_types et ON et.id = b.event_type_id
           WHERE b.cancel_token = ? AND b.status != 'cancelled'
           LIMIT 1`,
    args: [token],
  });
  const bk = full.rows[0];
  if (bk?.provider_event_id && bk.target_calendar_id) {
    try {
      const cr = await db.execute({
        sql: "SELECT * FROM calendars WHERE id = ?",
        args: [bk.target_calendar_id],
      });
      const cal = cr.rows[0];
      if (cal) {
        const client = await getProviderClientForCalendar(cal);
        const providerCalId =
          String(cal.provider).toLowerCase() === "ics"
            ? "ics-feed"
            : cal.provider_calendar_id;
        await client.deleteEvent(providerCalId, bk.provider_event_id);
      }
    } catch {
      // Best-effort; the booking row update below is the source of truth.
    }
  }

  await db.execute({
    sql: `UPDATE bookings
             SET status = 'cancelled', cancelled_at = ?
           WHERE cancel_token = ? AND status != 'cancelled'`,
    args: [Date.now(), token],
  });
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, status: "cancelled" }));
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await getHandler(req, res);
    if (req.method === "POST") return await postHandler(req, res);
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (e) {
    res.statusCode = e.statusCode || 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: e.message || "server error" }));
  }
}
