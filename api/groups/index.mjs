/**
 * GET  /api/groups   — list all groups the caller is an active member of
 * POST /api/groups   — create a group; caller becomes its owner
 *
 * Other group routes live alongside in this directory.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { pickUniqueSlug, readJson, sendError } from "../../lib/groups.mjs";
import { getTenantForUser } from "../../lib/polls.mjs";
import { enforceLimit } from "../../lib/entitlements.mjs";

async function listGroups(req, res) {
  const { user } = await requireUser(req);
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT g.id, g.name, g.slug, g.type, g.description, g.avatar_url,
                 g.created_by_user_id, g.created_at, g.updated_at,
                 m.role AS my_role, m.status AS my_status,
                 (SELECT COUNT(*) FROM group_memberships m2
                   WHERE m2.group_id = g.id AND m2.status = 'active') AS member_count
            FROM groups g
            JOIN group_memberships m ON m.group_id = g.id
           WHERE m.user_id = ? AND m.status = 'active'
           ORDER BY g.name`,
    args: [user.id],
  });
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      r.rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        type: row.type,
        description: row.description,
        avatar_url: row.avatar_url,
        created_by_user_id: row.created_by_user_id,
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
        my_role: row.my_role,
        member_count: Number(row.member_count),
      })),
    ),
  );
}

async function createGroup(req, res) {
  const { user } = await requireUser(req);
  const body = await readJson(req);
  const name = String(body.name || "").trim();
  const type = String(body.type || "").trim();
  if (!name) {
    const err = new Error("name is required");
    err.statusCode = 400;
    throw err;
  }
  if (type !== "family" && type !== "team") {
    const err = new Error("type must be 'family' or 'team'");
    err.statusCode = 400;
    throw err;
  }

  // Groups are a Family-plan feature (free + individual cap = 0). Soft
  // gate: block creation with an upgrade prompt. Existing groups (e.g.
  // created before a downgrade) keep working — we only block new ones.
  const tenant = await getTenantForUser(user.id);
  if (tenant) {
    const gate = await enforceLimit(tenant.id, "groups");
    if (!gate.allowed) {
      res.statusCode = gate.status;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ error: gate.reason, upgrade: true, plan: gate.plan }),
      );
      return;
    }
  }

  const db = getDb();
  const id = randomUUID();
  const membershipId = randomUUID();
  const slug = await pickUniqueSlug(name);
  const now = Date.now();

  // Create the group AND the creator's owner membership in lockstep. If we
  // ever lose either, the user gets locked out of their own group, so
  // either both land or neither does.
  await db.batch(
    [
      {
        sql: `INSERT INTO groups (id, name, slug, type, description, avatar_url, created_by_user_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        args: [
          id,
          name,
          slug,
          type,
          body.description ? String(body.description) : null,
          user.id,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO group_memberships
                (id, group_id, user_id, role, status, invited_by_user_id, joined_at, created_at)
              VALUES (?, ?, ?, 'owner', 'active', NULL, ?, ?)`,
        args: [membershipId, id, user.id, now, now],
      },
    ],
    "write",
  );

  res.statusCode = 201;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      id,
      name,
      slug,
      type,
      description: body.description || null,
      avatar_url: null,
      created_by_user_id: user.id,
      created_at: now,
      updated_at: now,
      my_role: "owner",
      member_count: 1,
    }),
  );
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await listGroups(req, res);
    if (req.method === "POST") return await createGroup(req, res);
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    sendError(res, err);
  }
}
