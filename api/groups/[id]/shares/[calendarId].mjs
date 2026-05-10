/**
 * PATCH  /api/groups/:id/shares/:calendarId  → change share_level
 * DELETE /api/groups/:id/shares/:calendarId  → stop sharing this calendar
 *
 * Both target the caller's own share row; other members' shares are not
 * mutable here (they belong to that user).
 */

import { getDb } from "../../../../db/client.mjs";
import { requireUser } from "../../../../lib/session.mjs";
import {
  loadGroupForUser,
  readJson,
  sendError,
} from "../../../../lib/groups.mjs";

const SHARE_LEVELS = ["full", "free_busy", "none"];

function parseIds(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // /api/groups/<id>/shares/<calendarId>
  const sharesIdx = segments.indexOf("shares");
  if (sharesIdx <= 0) return {};
  return {
    groupId: segments[sharesIdx - 1],
    calendarId: segments[sharesIdx + 1],
  };
}

async function patchShare(req, res, groupId, calendarId) {
  const { user } = await requireUser(req);
  await loadGroupForUser(groupId, user.id);

  const body = await readJson(req);
  if (!SHARE_LEVELS.includes(body.share_level)) {
    const err = new Error(
      `share_level must be one of: ${SHARE_LEVELS.join(", ")}`,
    );
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  const r = await db.execute({
    sql: `UPDATE group_calendar_shares
             SET share_level = ?
           WHERE group_id = ? AND user_id = ? AND calendar_id = ?`,
    args: [body.share_level, groupId, user.id, calendarId],
  });
  if (r.rowsAffected === 0) {
    const err = new Error("share not found");
    err.statusCode = 404;
    throw err;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, share_level: body.share_level }));
}

async function deleteShare(req, res, groupId, calendarId) {
  const { user } = await requireUser(req);
  await loadGroupForUser(groupId, user.id);

  const db = getDb();
  await db.execute({
    sql: `DELETE FROM group_calendar_shares
           WHERE group_id = ? AND user_id = ? AND calendar_id = ?`,
    args: [groupId, user.id, calendarId],
  });
  res.statusCode = 204;
  res.end();
}

export default async function handler(req, res) {
  try {
    const { groupId, calendarId } = parseIds(req);
    if (!groupId || !calendarId) {
      const err = new Error("group id and calendar id required");
      err.statusCode = 400;
      throw err;
    }
    if (req.method === "PATCH")
      return await patchShare(req, res, groupId, calendarId);
    if (req.method === "DELETE")
      return await deleteShare(req, res, groupId, calendarId);
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    sendError(res, err);
  }
}
