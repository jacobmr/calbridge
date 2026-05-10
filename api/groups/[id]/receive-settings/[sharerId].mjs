/**
 * PATCH /api/groups/:id/receive-settings/:sharerId
 *
 * Upserts how the caller (receiver) wants to receive events FROM :sharerId
 * within this group. Body fields are all optional; whatever's provided is
 * the new value (with sensible defaults on first write).
 *
 *   receive_level    : 'full' | 'free_busy' | 'none'
 *   push_level       : 'full' | 'busy_only' | 'none'
 *   event_prefix     : string | null
 *   acceptance_mode  : 'auto' | 'invite' | 'block'
 *
 * Both users must be active members of the group; sharer != receiver.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../../../db/client.mjs";
import { requireUser } from "../../../../lib/session.mjs";
import {
  loadGroupForUser,
  readJson,
  sendError,
} from "../../../../lib/groups.mjs";

const RECEIVE_LEVELS = ["full", "free_busy", "none"];
const PUSH_LEVELS = ["full", "busy_only", "none"];
const ACCEPTANCE_MODES = ["auto", "invite", "block"];

function parseIds(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // /api/groups/<id>/receive-settings/<sharerId>
  const idx = segments.indexOf("receive-settings");
  if (idx <= 0) return {};
  return {
    groupId: segments[idx - 1],
    sharerId: segments[idx + 1],
  };
}

async function assertActiveMember(groupId, userId) {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT 1 FROM group_memberships WHERE group_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
    args: [groupId, userId],
  });
  return r.rows.length > 0;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "PATCH") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const { groupId, sharerId } = parseIds(req);
    if (!groupId || !sharerId) {
      const err = new Error("group id and sharer id required");
      err.statusCode = 400;
      throw err;
    }

    const { user } = await requireUser(req);
    await loadGroupForUser(groupId, user.id);

    if (sharerId === user.id) {
      const err = new Error("you don't receive events from yourself");
      err.statusCode = 400;
      throw err;
    }
    if (!(await assertActiveMember(groupId, sharerId))) {
      const err = new Error("sharer is not an active member of this group");
      err.statusCode = 404;
      throw err;
    }

    const body = await readJson(req);
    // target_calendar_id (optional) must belong to the caller's tenant.
    // We validate ownership here rather than via FK so a bad id surfaces as
    // a 400 with a clear message instead of a 500.
    if (body.target_calendar_id) {
      const db2 = getDb();
      const own = await db2.execute({
        sql: `SELECT 1 FROM calendars c
                JOIN tenants t ON t.id = c.tenant_id
               WHERE c.id = ? AND t.owner_user_id = ?
               LIMIT 1`,
        args: [body.target_calendar_id, user.id],
      });
      if (own.rows.length === 0) {
        const err = new Error("target calendar must be one you own");
        err.statusCode = 400;
        throw err;
      }
    }
    if (
      body.receive_level !== undefined &&
      !RECEIVE_LEVELS.includes(body.receive_level)
    ) {
      const err = new Error(
        `receive_level must be one of: ${RECEIVE_LEVELS.join(", ")}`,
      );
      err.statusCode = 400;
      throw err;
    }
    if (
      body.push_level !== undefined &&
      !PUSH_LEVELS.includes(body.push_level)
    ) {
      const err = new Error(
        `push_level must be one of: ${PUSH_LEVELS.join(", ")}`,
      );
      err.statusCode = 400;
      throw err;
    }
    if (
      body.acceptance_mode !== undefined &&
      !ACCEPTANCE_MODES.includes(body.acceptance_mode)
    ) {
      const err = new Error(
        `acceptance_mode must be one of: ${ACCEPTANCE_MODES.join(", ")}`,
      );
      err.statusCode = 400;
      throw err;
    }

    const db = getDb();
    const now = Date.now();
    const existing = await db.execute({
      sql: `SELECT id, receive_level, push_level, event_prefix, acceptance_mode,
                   target_calendar_id
              FROM group_receive_settings
             WHERE group_id = ? AND receiver_user_id = ? AND sharer_user_id = ?`,
      args: [groupId, user.id, sharerId],
    });

    if (existing.rows[0]) {
      const cur = existing.rows[0];
      const next = {
        receive_level: body.receive_level ?? cur.receive_level,
        push_level: body.push_level ?? cur.push_level,
        event_prefix:
          body.event_prefix !== undefined
            ? body.event_prefix || null
            : cur.event_prefix,
        acceptance_mode: body.acceptance_mode ?? cur.acceptance_mode,
        target_calendar_id:
          body.target_calendar_id !== undefined
            ? body.target_calendar_id || null
            : cur.target_calendar_id,
      };
      await db.execute({
        sql: `UPDATE group_receive_settings
                 SET receive_level = ?, push_level = ?, event_prefix = ?,
                     acceptance_mode = ?, target_calendar_id = ?, updated_at = ?
               WHERE id = ?`,
        args: [
          next.receive_level,
          next.push_level,
          next.event_prefix,
          next.acceptance_mode,
          next.target_calendar_id,
          now,
          cur.id,
        ],
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: cur.id,
          sharer_user_id: sharerId,
          ...next,
          updated_at: now,
        }),
      );
      return;
    }

    // First write — fall back to schema defaults for anything not provided.
    const id = randomUUID();
    const fresh = {
      receive_level: body.receive_level ?? "full",
      push_level: body.push_level ?? "none",
      event_prefix:
        body.event_prefix !== undefined ? body.event_prefix || null : null,
      acceptance_mode: body.acceptance_mode ?? "auto",
      target_calendar_id: body.target_calendar_id || null,
    };
    await db.execute({
      sql: `INSERT INTO group_receive_settings
              (id, group_id, receiver_user_id, sharer_user_id,
               receive_level, push_level, event_prefix, acceptance_mode,
               target_calendar_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        groupId,
        user.id,
        sharerId,
        fresh.receive_level,
        fresh.push_level,
        fresh.event_prefix,
        fresh.acceptance_mode,
        fresh.target_calendar_id,
        now,
        now,
      ],
    });

    res.statusCode = 201;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id,
        sharer_user_id: sharerId,
        ...fresh,
        updated_at: now,
      }),
    );
  } catch (err) {
    sendError(res, err);
  }
}
