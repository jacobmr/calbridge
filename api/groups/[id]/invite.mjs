/**
 * POST /api/groups/:id/invite — admin/owner invites someone by email
 *
 * If a user with that email exists, a pending membership is created (idempotent
 * for existing pending invites). If the user doesn't exist yet, we still
 * create a placeholder membership keyed by email — they'll be linked to the
 * actual user row when they sign up.
 *
 * Vercel routes /api/groups/:id/invite to this file via the literal "invite"
 * segment. We parse :id from the URL.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../../db/client.mjs";
import { requireUser } from "../../../lib/session.mjs";
import {
  loadGroupForUser,
  readJson,
  requireRole,
  sendError,
} from "../../../lib/groups.mjs";

function parseGroupId(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // /api/groups/<id>/invite → segments = ["api","groups","<id>","invite"]
  const inviteIdx = segments.indexOf("invite");
  if (inviteIdx <= 0) return null;
  return segments[inviteIdx - 1];
}

async function findUserByEmail(email) {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT id, email, display_name FROM users WHERE LOWER(email) = LOWER(?)",
    args: [email],
  });
  return r.rows[0] || null;
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
    const { membership } = await loadGroupForUser(groupId, user.id);
    requireRole(membership, "admin");

    const body = await readJson(req);
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const role = ["admin", "member"].includes(body.role) ? body.role : "member";

    if (!email || !email.includes("@")) {
      const err = new Error("valid email is required");
      err.statusCode = 400;
      throw err;
    }
    if (email === String(user.email || "").toLowerCase()) {
      const err = new Error("you're already in this group");
      err.statusCode = 400;
      throw err;
    }

    const target = await findUserByEmail(email);
    if (!target) {
      // No matching user yet. We could create a "pending by email" record,
      // but the schema keys memberships by user_id (NOT NULL). For now,
      // the inviter has to wait for the invitee to sign up. This is a
      // reasonable v1 constraint — we'll add email-keyed pending invites
      // when we build the email notification flow.
      const err = new Error(
        "no MiCal user with that email yet — ask them to sign up first",
      );
      err.statusCode = 404;
      throw err;
    }

    const db = getDb();

    // Idempotent: if a membership row already exists, surface its current
    // state instead of erroring. Re-inviting a removed member flips them
    // back to pending.
    const existing = await db.execute({
      sql: "SELECT id, status, role FROM group_memberships WHERE group_id = ? AND user_id = ?",
      args: [groupId, target.id],
    });
    const now = Date.now();

    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.status === "active") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            already_member: true,
            user_id: target.id,
            email: target.email,
            role: row.role,
            status: "active",
          }),
        );
        return;
      }
      // pending or removed → reset to pending with the requested role
      await db.execute({
        sql: `UPDATE group_memberships
                 SET status = 'pending', role = ?, invited_by_user_id = ?, joined_at = NULL
               WHERE id = ?`,
        args: [role, user.id, row.id],
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          membership_id: row.id,
          user_id: target.id,
          email: target.email,
          role,
          status: "pending",
        }),
      );
      return;
    }

    const membershipId = randomUUID();
    await db.execute({
      sql: `INSERT INTO group_memberships
              (id, group_id, user_id, role, status, invited_by_user_id, joined_at, created_at)
            VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?)`,
      args: [membershipId, groupId, target.id, role, user.id, now],
    });

    res.statusCode = 201;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        membership_id: membershipId,
        user_id: target.id,
        email: target.email,
        role,
        status: "pending",
      }),
    );
  } catch (err) {
    sendError(res, err);
  }
}
