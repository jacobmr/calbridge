/**
 * POST /api/groups/redeem-invite
 *
 * Body: { token }
 *
 * Redeems an email-keyed group invite for the currently signed-in user.
 * The invite is matched by token; we verify the user's email matches
 * the invite's recipient before binding a membership. Idempotent — calling
 * twice (e.g. dashboard reload after redeem) returns 200 with already_member.
 *
 * Returns: { group_id, group_name, group_type, status: 'active' | 'already_member' }
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { readJson, sendError } from "../../lib/groups.mjs";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const token = String(body.token || "").trim();
    if (!token) {
      const err = new Error("token required");
      err.statusCode = 400;
      throw err;
    }

    const db = getDb();
    const r = await db.execute({
      sql: `SELECT id, group_id, email, role, expires_at
              FROM group_invites WHERE token = ?`,
      args: [token],
    });
    const invite = r.rows[0];
    if (!invite) {
      const err = new Error("invite not found or already used");
      err.statusCode = 404;
      throw err;
    }
    if (Number(invite.expires_at) < Date.now()) {
      // Clean up while we're here.
      await db.execute({
        sql: "DELETE FROM group_invites WHERE id = ?",
        args: [invite.id],
      });
      const err = new Error("invite expired — ask the inviter to resend");
      err.statusCode = 410;
      throw err;
    }
    if (
      String(user.email || "").toLowerCase() !==
      String(invite.email || "").toLowerCase()
    ) {
      // Don't tell them whose invite they tried to claim — just refuse.
      const err = new Error(
        "this invite was sent to a different email address",
      );
      err.statusCode = 403;
      throw err;
    }

    // Look up group for the response payload.
    const g = await db.execute({
      sql: "SELECT id, name, type FROM groups WHERE id = ?",
      args: [invite.group_id],
    });
    const group = g.rows[0];
    if (!group) {
      // Race: group deleted between invite and redeem.
      await db.execute({
        sql: "DELETE FROM group_invites WHERE id = ?",
        args: [invite.id],
      });
      const err = new Error("the group no longer exists");
      err.statusCode = 410;
      throw err;
    }

    // Already a member? Just consume the invite and report.
    const existing = await db.execute({
      sql: "SELECT id, status FROM group_memberships WHERE group_id = ? AND user_id = ?",
      args: [invite.group_id, user.id],
    });
    if (existing.rows[0] && existing.rows[0].status === "active") {
      await db.execute({
        sql: "DELETE FROM group_invites WHERE id = ?",
        args: [invite.id],
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          group_id: group.id,
          group_name: group.name,
          group_type: group.type,
          status: "already_member",
        }),
      );
      return;
    }

    const now = Date.now();
    if (existing.rows[0]) {
      // Pending or removed → flip to active and grant the invited role.
      await db.execute({
        sql: `UPDATE group_memberships
                 SET status = 'active', role = ?, joined_at = ?
               WHERE id = ?`,
        args: [invite.role, now, existing.rows[0].id],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO group_memberships
                (id, group_id, user_id, role, status, joined_at, created_at)
              VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        args: [randomUUID(), invite.group_id, user.id, invite.role, now, now],
      });
    }
    await db.execute({
      sql: "DELETE FROM group_invites WHERE id = ?",
      args: [invite.id],
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        group_id: group.id,
        group_name: group.name,
        group_type: group.type,
        status: "active",
      }),
    );
  } catch (err) {
    sendError(res, err);
  }
}
