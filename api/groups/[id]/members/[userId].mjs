/**
 * DELETE /api/groups/:id/members/:userId — remove a member (admin/owner)
 * PATCH  /api/groups/:id/members/:userId — change a member's role (owner only)
 *
 * Guardrails:
 *   - You can leave a group by removing yourself, even as a member.
 *   - You cannot demote or remove the last owner — somebody has to hold
 *     the keys.
 */

import { getDb } from "../../../../db/client.mjs";
import { requireUser } from "../../../../lib/session.mjs";
import {
  loadGroupForUser,
  readJson,
  requireRole,
  sendError,
} from "../../../../lib/groups.mjs";

function parseIds(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // /api/groups/<id>/members/<userId> → ["api","groups","<id>","members","<userId>"]
  const membersIdx = segments.indexOf("members");
  if (membersIdx <= 0) return {};
  return {
    groupId: segments[membersIdx - 1],
    targetUserId: segments[membersIdx + 1],
  };
}

async function countOwners(groupId) {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n
            FROM group_memberships
           WHERE group_id = ? AND role = 'owner' AND status = 'active'`,
    args: [groupId],
  });
  return Number(r.rows[0]?.n || 0);
}

async function removeMember(req, res, groupId, targetUserId) {
  const { user } = await requireUser(req);
  const { membership } = await loadGroupForUser(groupId, user.id);

  // Removing yourself is allowed for any role; removing others requires admin+.
  const isSelf = targetUserId === user.id;
  if (!isSelf) requireRole(membership, "admin");

  const db = getDb();
  const r = await db.execute({
    sql: "SELECT id, role, status FROM group_memberships WHERE group_id = ? AND user_id = ?",
    args: [groupId, targetUserId],
  });
  const target = r.rows[0];
  if (!target) {
    const err = new Error("member not found");
    err.statusCode = 404;
    throw err;
  }

  if (target.role === "owner") {
    const owners = await countOwners(groupId);
    if (owners <= 1) {
      const err = new Error(
        "can't remove the last owner — promote someone else first",
      );
      err.statusCode = 400;
      throw err;
    }
  }

  // We hard-delete pending invites (treat as cancellation), but flip active
  // memberships to status='removed' so they can be re-invited cleanly.
  if (target.status === "pending") {
    await db.execute({
      sql: "DELETE FROM group_memberships WHERE id = ?",
      args: [target.id],
    });
  } else {
    await db.execute({
      sql: "UPDATE group_memberships SET status = 'removed' WHERE id = ?",
      args: [target.id],
    });
  }

  res.statusCode = 204;
  res.end();
}

async function patchMember(req, res, groupId, targetUserId) {
  const { user } = await requireUser(req);
  const { membership } = await loadGroupForUser(groupId, user.id);
  // Only owners can change roles. Admins can invite/remove but not crown.
  requireRole(membership, "owner");

  const body = await readJson(req);
  const newRole = String(body.role || "");
  if (!["owner", "admin", "member"].includes(newRole)) {
    const err = new Error("role must be owner/admin/member");
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  const r = await db.execute({
    sql: "SELECT id, role FROM group_memberships WHERE group_id = ? AND user_id = ?",
    args: [groupId, targetUserId],
  });
  const target = r.rows[0];
  if (!target) {
    const err = new Error("member not found");
    err.statusCode = 404;
    throw err;
  }

  // Don't strand the group ownerless on a demotion.
  if (target.role === "owner" && newRole !== "owner") {
    const owners = await countOwners(groupId);
    if (owners <= 1) {
      const err = new Error(
        "can't demote the last owner — promote someone else first",
      );
      err.statusCode = 400;
      throw err;
    }
  }

  await db.execute({
    sql: "UPDATE group_memberships SET role = ? WHERE id = ?",
    args: [newRole, target.id],
  });

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, role: newRole }));
}

export default async function handler(req, res) {
  try {
    const { groupId, targetUserId } = parseIds(req);
    if (!groupId || !targetUserId) {
      const err = new Error("group id and user id required");
      err.statusCode = 400;
      throw err;
    }
    if (req.method === "DELETE")
      return await removeMember(req, res, groupId, targetUserId);
    if (req.method === "PATCH")
      return await patchMember(req, res, groupId, targetUserId);
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    sendError(res, err);
  }
}
