/**
 * GET    /api/groups/:id   — group details + members + my role
 * PATCH  /api/groups/:id   — update name/description/type/avatar (admin+)
 * DELETE /api/groups/:id   — delete the group (owner only)
 */

import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import {
  loadGroupForUser,
  readJson,
  requireRole,
  sendError,
} from "../../lib/groups.mjs";

function parseId(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // /api/groups/abc → segments = ["api", "groups", "abc"]
  return segments[segments.length - 1];
}

async function getGroup(req, res, groupId) {
  const { user } = await requireUser(req);
  const { group, membership } = await loadGroupForUser(groupId, user.id);

  // Include members so a single fetch backs the group settings page.
  const db = getDb();
  const m = await db.execute({
    sql: `SELECT m.id          AS membership_id,
                 m.user_id, m.role, m.status,
                 m.joined_at, m.created_at,
                 u.email, u.display_name
            FROM group_memberships m
            JOIN users u ON u.id = m.user_id
           WHERE m.group_id = ?
           ORDER BY m.role DESC, m.created_at ASC`,
    args: [groupId],
  });

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      ...group,
      my_role: membership.role,
      members: m.rows.map((row) => ({
        membership_id: row.membership_id,
        user_id: row.user_id,
        email: row.email,
        display_name: row.display_name,
        role: row.role,
        status: row.status,
        joined_at: row.joined_at != null ? Number(row.joined_at) : null,
        created_at: Number(row.created_at),
      })),
    }),
  );
}

async function patchGroup(req, res, groupId) {
  const { user } = await requireUser(req);
  const { membership } = await loadGroupForUser(groupId, user.id);
  requireRole(membership, "admin");

  const body = await readJson(req);
  const updates = [];
  const args = [];

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) {
      const err = new Error("name cannot be empty");
      err.statusCode = 400;
      throw err;
    }
    updates.push("name = ?");
    args.push(name);
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    args.push(body.description ? String(body.description) : null);
  }
  if (body.avatar_url !== undefined) {
    updates.push("avatar_url = ?");
    args.push(body.avatar_url ? String(body.avatar_url) : null);
  }
  if (body.type !== undefined) {
    if (body.type !== "family" && body.type !== "team") {
      const err = new Error("type must be 'family' or 'team'");
      err.statusCode = 400;
      throw err;
    }
    updates.push("type = ?");
    args.push(body.type);
  }

  if (updates.length === 0) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, changed: 0 }));
    return;
  }

  updates.push("updated_at = ?");
  args.push(Date.now());
  args.push(groupId);

  const db = getDb();
  await db.execute({
    sql: `UPDATE groups SET ${updates.join(", ")} WHERE id = ?`,
    args,
  });

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, changed: updates.length - 1 }));
}

async function deleteGroup(req, res, groupId) {
  const { user } = await requireUser(req);
  const { membership } = await loadGroupForUser(groupId, user.id);
  // Only owner — admins can manage but can't nuke the whole group.
  requireRole(membership, "owner");

  const db = getDb();
  // Cascades remove memberships, shares, receive settings, and group-scoped
  // sync_flows / event_types. bookings keep their group_id (NULL out via
  // ON DELETE without cascade was not specified) — they live on as records.
  await db.execute({
    sql: "DELETE FROM groups WHERE id = ?",
    args: [groupId],
  });

  res.statusCode = 204;
  res.end();
}

export default async function handler(req, res) {
  try {
    const groupId = parseId(req);
    if (!groupId) {
      const err = new Error("group id required");
      err.statusCode = 400;
      throw err;
    }
    if (req.method === "GET") return await getGroup(req, res, groupId);
    if (req.method === "PATCH") return await patchGroup(req, res, groupId);
    if (req.method === "DELETE") return await deleteGroup(req, res, groupId);
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    sendError(res, err);
  }
}
