/**
 * Group helpers shared across /api/groups/* handlers.
 *
 * Conventions:
 *   - Throws Error with .statusCode set so handlers can map to HTTP responses.
 *   - "active membership" means group_memberships.status='active' (not pending/removed).
 *   - Role hierarchy: owner > admin > member. We compare via roleAtLeast().
 */

import { getDb } from "../db/client.mjs";

const ROLE_RANK = { member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role, minRole) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
}

/**
 * Resolve the caller's active membership for a given group. Throws 403 if
 * they aren't a member; 404 if the group doesn't exist.
 *
 * @returns {Promise<{group: object, membership: object}>}
 */
export async function loadGroupForUser(groupId, userId) {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT g.*,
                 m.role        AS member_role,
                 m.status      AS member_status,
                 m.id          AS membership_id
            FROM groups g
            LEFT JOIN group_memberships m
              ON m.group_id = g.id AND m.user_id = ?
           WHERE g.id = ?`,
    args: [userId, groupId],
  });
  const row = r.rows[0];
  if (!row) {
    const err = new Error("group not found");
    err.statusCode = 404;
    throw err;
  }
  if (!row.member_role || row.member_status !== "active") {
    // Don't leak existence to non-members beyond 404.
    const err = new Error("group not found");
    err.statusCode = 404;
    throw err;
  }
  return {
    group: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      type: row.type,
      description: row.description,
      avatar_url: row.avatar_url,
      created_by_user_id: row.created_by_user_id,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    },
    membership: {
      id: row.membership_id,
      role: row.member_role,
      status: row.member_status,
    },
  };
}

/** Throw 403 unless the caller's role is at least minRole. */
export function requireRole(membership, minRole) {
  if (!roleAtLeast(membership.role, minRole)) {
    const err = new Error(`requires role: ${minRole} or higher`);
    err.statusCode = 403;
    throw err;
  }
}

/**
 * Generate a URL-safe slug from a name. Falls back to a random suffix
 * if the cleaned slug is empty (e.g., name was emoji-only).
 */
export function slugifyName(name) {
  let s = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
  if (!s) s = "group";
  return s;
}

/**
 * Pick a slug that doesn't collide with existing group slugs. Appends a
 * short random suffix when necessary. Race-safe enough for our scale —
 * the UNIQUE constraint will still catch a collision and reject.
 */
export async function pickUniqueSlug(base) {
  const db = getDb();
  const baseSlug = slugifyName(base);
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`;
    const r = await db.execute({
      sql: "SELECT 1 FROM groups WHERE slug = ? LIMIT 1",
      args: [candidate],
    });
    if (r.rows.length === 0) return candidate;
  }
  return `${baseSlug}-${randomSuffix()}-${randomSuffix()}`;
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6);
}

/** Common JSON read helper — same pattern other handlers use. */
export function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
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

/** Send a JSON error in the project's standard shape. */
export function sendError(res, err) {
  const status = err.statusCode || 500;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: err.message || "server error" }));
}
