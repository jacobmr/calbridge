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

import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "../../../db/client.mjs";
import { requireUser } from "../../../lib/session.mjs";
import {
  loadGroupForUser,
  readJson,
  requireRole,
  sendError,
} from "../../../lib/groups.mjs";
import { sendGroupInviteEmail } from "../../../lib/email.mjs";

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function appBaseUrl() {
  return process.env.APP_BASE_URL || "https://www.mical.net";
}

function newInviteToken() {
  return randomBytes(24).toString("base64url");
}

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
    const db = getDb();

    // Inviting someone who isn't a MiCal user yet — the whole point of
    // an "invite to MiCal" flow. We create an email-keyed invite with a
    // token-based signup link; on first OAuth sign-in with this email,
    // the OAuth callback converts the invite to an active membership.
    if (!target) {
      const now = Date.now();
      // Idempotent: re-inviting the same email refreshes token + role.
      const existing = await db.execute({
        sql: "SELECT id FROM group_invites WHERE group_id = ? AND email = ?",
        args: [groupId, email],
      });
      const token = newInviteToken();
      if (existing.rows[0]) {
        await db.execute({
          sql: `UPDATE group_invites
                   SET token = ?, role = ?, invited_by_user_id = ?,
                       created_at = ?, expires_at = ?
                 WHERE id = ?`,
          args: [
            token,
            role,
            user.id,
            now,
            now + INVITE_TTL_MS,
            existing.rows[0].id,
          ],
        });
      } else {
        await db.execute({
          sql: `INSERT INTO group_invites
                  (id, group_id, email, role, token, invited_by_user_id,
                   created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            randomUUID(),
            groupId,
            email,
            role,
            token,
            user.id,
            now,
            now + INVITE_TTL_MS,
          ],
        });
      }
      const inviteUrl = `${appBaseUrl()}/login?invite=${encodeURIComponent(token)}`;

      // Look up group name + type for the email body. We already loaded the
      // membership above, but loadGroupForUser only returned membership.
      // Re-query the group itself — cheap, one round-trip.
      const gRow = await db.execute({
        sql: "SELECT name, type FROM groups WHERE id = ? LIMIT 1",
        args: [groupId],
      });
      const group = gRow.rows[0] || { name: "MiCal group", type: "family" };

      // Try to email the invite. Failure (no API key, network, Resend
      // 4xx/5xx) is non-fatal — we still return invite_url so the
      // inviter can copy/share it manually. The response signals which
      // happened so the UI can decide what to show.
      const emailResult = await sendGroupInviteEmail({
        toEmail: email,
        inviterName: user.display_name,
        inviterEmail: user.email,
        groupName: group.name,
        groupType: group.type,
        inviteUrl,
      });

      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          status: "pending_signup",
          email,
          role,
          email_sent: emailResult.sent,
          email_failure_reason: emailResult.sent
            ? undefined
            : emailResult.reason,
          invite_url: inviteUrl,
          expires_at: now + INVITE_TTL_MS,
        }),
      );
      return;
    }

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
