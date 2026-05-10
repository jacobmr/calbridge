/**
 * POST /api/groups/:id/join — accept a pending invite
 *
 * The caller must have a pending membership row in this group. Sets it to
 * 'active' with joined_at = now.
 */

import { getDb } from "../../../db/client.mjs";
import { requireUser } from "../../../lib/session.mjs";
import { sendError } from "../../../lib/groups.mjs";

function parseGroupId(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // /api/groups/<id>/join → segments = ["api","groups","<id>","join"]
  const joinIdx = segments.indexOf("join");
  if (joinIdx <= 0) return null;
  return segments[joinIdx - 1];
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const groupId = parseGroupId(req);
    if (!groupId) {
      const err = new Error("group id required");
      err.statusCode = 400;
      throw err;
    }

    const { user } = await requireUser(req);
    const db = getDb();
    const r = await db.execute({
      sql: "SELECT id, status FROM group_memberships WHERE group_id = ? AND user_id = ?",
      args: [groupId, user.id],
    });
    const row = r.rows[0];
    if (!row) {
      const err = new Error("no invitation to this group");
      err.statusCode = 404;
      throw err;
    }
    if (row.status === "active") {
      // Idempotent — already a member.
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, already_member: true }));
      return;
    }
    if (row.status === "removed") {
      const err = new Error("you were removed from this group");
      err.statusCode = 403;
      throw err;
    }

    const now = Date.now();
    await db.execute({
      sql: "UPDATE group_memberships SET status = 'active', joined_at = ? WHERE id = ?",
      args: [now, row.id],
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ ok: true, membership_id: row.id, joined_at: now }),
    );
  } catch (err) {
    sendError(res, err);
  }
}
