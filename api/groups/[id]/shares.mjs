/**
 * GET  /api/groups/:id/shares  → everything the caller needs to render the
 *                                "what I share / how I receive" page:
 *                                  { mine: [shares], receiveSettings: [per-sharer] }
 * POST /api/groups/:id/shares  → add a calendar to the group (or change level
 *                                if the row already exists — idempotent).
 *                                Body: { calendar_id, share_level? }
 *
 * Per-share patch/delete live in shares/[calendarId].mjs.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../../db/client.mjs";
import { requireUser } from "../../../lib/session.mjs";
import { loadGroupForUser, readJson, sendError } from "../../../lib/groups.mjs";

const SHARE_LEVELS = ["full", "free_busy", "none"];

function parseGroupId(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // /api/groups/<id>/shares → ["api","groups","<id>","shares"]
  const sharesIdx = segments.indexOf("shares");
  if (sharesIdx <= 0) return null;
  return segments[sharesIdx - 1];
}

async function listMyShares(req, res, groupId) {
  const { user } = await requireUser(req);
  await loadGroupForUser(groupId, user.id); // 404 if not a member

  const db = getDb();
  const [shares, settings] = await Promise.all([
    db.execute({
      sql: `SELECT s.id, s.calendar_id, s.share_level, s.created_at,
                   c.label, c.provider
              FROM group_calendar_shares s
              JOIN calendars c ON c.id = s.calendar_id
             WHERE s.group_id = ? AND s.user_id = ?
             ORDER BY c.label`,
      args: [groupId, user.id],
    }),
    db.execute({
      sql: `SELECT id, sharer_user_id, receive_level, push_level,
                   event_prefix, acceptance_mode, target_calendar_id,
                   updated_at
              FROM group_receive_settings
             WHERE group_id = ? AND receiver_user_id = ?`,
      args: [groupId, user.id],
    }),
  ]);

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      mine: shares.rows.map((row) => ({
        id: row.id,
        calendar_id: row.calendar_id,
        calendar_label: row.label,
        calendar_provider: row.provider,
        share_level: row.share_level,
        created_at: Number(row.created_at),
      })),
      receiveSettings: settings.rows.map((row) => ({
        id: row.id,
        sharer_user_id: row.sharer_user_id,
        receive_level: row.receive_level,
        push_level: row.push_level,
        event_prefix: row.event_prefix,
        acceptance_mode: row.acceptance_mode,
        target_calendar_id: row.target_calendar_id,
        updated_at: Number(row.updated_at),
      })),
    }),
  );
}

async function addOrUpdateShare(req, res, groupId) {
  const { user } = await requireUser(req);
  await loadGroupForUser(groupId, user.id);

  const body = await readJson(req);
  const calendarId = String(body.calendar_id || "").trim();
  const shareLevel = body.share_level || "full";
  if (!calendarId) {
    const err = new Error("calendar_id is required");
    err.statusCode = 400;
    throw err;
  }
  if (!SHARE_LEVELS.includes(shareLevel)) {
    const err = new Error(
      `share_level must be one of: ${SHARE_LEVELS.join(", ")}`,
    );
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  // The calendar must belong to a tenant the caller owns. (In v1 every user
  // owns one tenant; later we'll widen this to any tenant they can access.)
  const cal = await db.execute({
    sql: `SELECT c.id, c.label
            FROM calendars c
            JOIN tenants t ON t.id = c.tenant_id
           WHERE c.id = ? AND t.owner_user_id = ?`,
    args: [calendarId, user.id],
  });
  if (!cal.rows[0]) {
    const err = new Error("calendar not found or not yours to share");
    err.statusCode = 404;
    throw err;
  }

  const now = Date.now();
  // Upsert. A user changing levels on a calendar already in the group is the
  // common case — same row, different share_level.
  const existing = await db.execute({
    sql: "SELECT id FROM group_calendar_shares WHERE group_id = ? AND user_id = ? AND calendar_id = ?",
    args: [groupId, user.id, calendarId],
  });

  if (existing.rows[0]) {
    await db.execute({
      sql: "UPDATE group_calendar_shares SET share_level = ? WHERE id = ?",
      args: [shareLevel, existing.rows[0].id],
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: existing.rows[0].id,
        calendar_id: calendarId,
        share_level: shareLevel,
        already_existed: true,
      }),
    );
    return;
  }

  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO group_calendar_shares
            (id, group_id, user_id, calendar_id, share_level, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, groupId, user.id, calendarId, shareLevel, now],
  });

  res.statusCode = 201;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      id,
      calendar_id: calendarId,
      calendar_label: cal.rows[0].label,
      share_level: shareLevel,
      created_at: now,
    }),
  );
}

export default async function handler(req, res) {
  try {
    const groupId = parseGroupId(req);
    if (!groupId) {
      const err = new Error("group id required");
      err.statusCode = 400;
      throw err;
    }
    if (req.method === "GET") return await listMyShares(req, res, groupId);
    if (req.method === "POST") return await addOrUpdateShare(req, res, groupId);
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    sendError(res, err);
  }
}
