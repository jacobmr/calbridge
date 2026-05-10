/**
 * GET    /api/polls/[id] — detail w/ options + responses (organizer only)
 * PATCH  /api/polls/[id] — edit title/desc/duration/options while status='open'
 * DELETE /api/polls/[id] — hard delete (cascades options + responses)
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../../db/client.mjs";
import { requireUser } from "../../../lib/session.mjs";
import { readJson, sendError } from "../../../lib/groups.mjs";
import { getTenantForUser, loadPollDetail } from "../../../lib/polls.mjs";

function parsePollId(req) {
  // Capture the segment after /api/polls/, regardless of whether the URL
  // continues with a sub-action like /close or /schedule. More robust than
  // index-based slicing across runtime path conventions.
  const url = new URL(req.url, "http://localhost");
  const m = url.pathname.match(/\/api\/polls\/([^/?#]+)/);
  return m ? m[1] : null;
}

// Confirm the poll exists, belongs to the caller's tenant, and the caller is
// the organizer (we don't yet support multi-organizer polls — keep it simple).
async function authorizeOrganizer(req) {
  const { user } = await requireUser(req);
  const id = parsePollId(req);
  if (!id) {
    const e = new Error("missing poll id");
    e.statusCode = 400;
    throw e;
  }
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    const e = new Error("tenant not found");
    e.statusCode = 404;
    throw e;
  }
  const db = getDb();
  const row = await db.execute({
    sql: "SELECT * FROM polls WHERE id = ? LIMIT 1",
    args: [id],
  });
  const poll = row.rows[0];
  if (!poll || poll.tenant_id !== tenant.id) {
    const e = new Error("poll not found");
    e.statusCode = 404;
    throw e;
  }
  if (poll.organizer_user_id !== user.id) {
    const e = new Error("not the organizer");
    e.statusCode = 403;
    throw e;
  }
  return { user, tenant, poll };
}

async function getPoll(req, res) {
  const { poll } = await authorizeOrganizer(req);
  const detail = await loadPollDetail(poll.id, { withResponses: true });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(detail));
}

async function updatePoll(req, res) {
  const { poll } = await authorizeOrganizer(req);
  if (poll.status !== "open") {
    return sendError(
      res,
      Object.assign(new Error("can only edit open polls"), { statusCode: 400 }),
    );
  }
  const body = await readJson(req);
  const updates = [];
  const args = [];

  if (typeof body.title === "string") {
    const t = body.title.trim();
    if (!t) {
      return sendError(
        res,
        Object.assign(new Error("title cannot be empty"), { statusCode: 400 }),
      );
    }
    updates.push("title = ?");
    args.push(t);
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    args.push(body.description ? String(body.description).trim() : null);
  }
  if (body.location_text !== undefined) {
    updates.push("location_text = ?");
    args.push(body.location_text ? String(body.location_text).trim() : null);
  }
  if (body.duration_min !== undefined) {
    const d = Number(body.duration_min);
    if (!Number.isFinite(d) || d < 5 || d > 24 * 60) {
      return sendError(
        res,
        Object.assign(new Error("invalid duration_min"), { statusCode: 400 }),
      );
    }
    updates.push("duration_min = ?");
    args.push(d);
  }
  if (body.require_email !== undefined) {
    updates.push("require_email = ?");
    args.push(body.require_email ? 1 : 0);
  }

  const db = getDb();
  const now = Date.now();
  const tx = await db.transaction("write");
  try {
    if (updates.length) {
      updates.push("updated_at = ?");
      args.push(now);
      args.push(poll.id);
      await tx.execute({
        sql: `UPDATE polls SET ${updates.join(", ")} WHERE id = ?`,
        args,
      });
    }
    // Replace options when caller supplies them. Simpler than diffing — and
    // safe because responses reference option_ids, but the partial unique
    // index on responses is by (poll, identifier), not by option, so changing
    // option ids leaves prior votes orphaned (treated as "no longer pickable").
    // The detail view filters them out gracefully.
    if (Array.isArray(body.options)) {
      if (body.options.length < 2) {
        await tx.rollback();
        return sendError(
          res,
          Object.assign(new Error("at least 2 options are required"), {
            statusCode: 400,
          }),
        );
      }
      await tx.execute({
        sql: "DELETE FROM poll_options WHERE poll_id = ?",
        args: [poll.id],
      });
      let ord = 0;
      const duration = Number(body.duration_min || poll.duration_min);
      for (const o of body.options) {
        const start = Number(o.start_ms);
        const end = Number.isFinite(Number(o.end_ms))
          ? Number(o.end_ms)
          : start + duration * 60 * 1000;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          await tx.rollback();
          return sendError(
            res,
            Object.assign(new Error("invalid option times"), {
              statusCode: 400,
            }),
          );
        }
        await tx.execute({
          sql: `INSERT INTO poll_options (id, poll_id, start_ms, end_ms, ord, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [randomUUID(), poll.id, start, end, ord++, now],
        });
      }
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  const detail = await loadPollDetail(poll.id, { withResponses: true });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(detail));
}

async function deletePoll(req, res) {
  const { poll } = await authorizeOrganizer(req);
  const db = getDb();
  await db.execute({ sql: "DELETE FROM polls WHERE id = ?", args: [poll.id] });
  res.statusCode = 204;
  res.end();
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await getPoll(req, res);
    if (req.method === "PATCH") return await updatePoll(req, res);
    if (req.method === "DELETE") return await deletePoll(req, res);
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    sendError(res, err);
  }
}
