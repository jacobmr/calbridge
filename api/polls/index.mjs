/**
 * GET  /api/polls — list polls owned by the caller's tenant
 * POST /api/polls — create a poll with its candidate options in one shot
 */

import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { readJson, sendError } from "../../lib/groups.mjs";
import {
  getTenantForUser,
  insertPollWithOptions,
  loadPollDetail,
} from "../../lib/polls.mjs";

async function listPolls(req, res) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }
  const db = getDb();
  const pollsRes = await db.execute({
    sql: `SELECT p.id, p.title, p.description, p.duration_min, p.location_text,
                 p.token, p.status, p.require_email, p.closes_at,
                 p.created_at, p.updated_at,
                 (SELECT COUNT(*) FROM poll_options o WHERE o.poll_id = p.id) AS option_count,
                 (SELECT COUNT(*) FROM poll_responses r WHERE r.poll_id = p.id) AS response_count
            FROM polls p
           WHERE p.tenant_id = ?
           ORDER BY p.created_at DESC`,
    args: [tenant.id],
  });
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      pollsRes.rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        duration_min: Number(row.duration_min),
        location_text: row.location_text,
        token: row.token,
        status: row.status,
        require_email: Number(row.require_email) === 1,
        closes_at: row.closes_at ? Number(row.closes_at) : null,
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
        option_count: Number(row.option_count),
        response_count: Number(row.response_count),
      })),
    ),
  );
}

async function createPoll(req, res) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }
  const body = await readJson(req);
  const title = String(body.title || "").trim();
  const description =
    body.description != null ? String(body.description).trim() : null;
  const durationMin = Number(body.duration_min);
  const locationText =
    body.location_text != null ? String(body.location_text).trim() : null;
  const requireEmail = body.require_email !== false; // default true
  const options = Array.isArray(body.options) ? body.options : [];

  if (!title) {
    return sendError(
      res,
      Object.assign(new Error("title is required"), { statusCode: 400 }),
    );
  }
  if (
    !Number.isFinite(durationMin) ||
    durationMin < 5 ||
    durationMin > 24 * 60
  ) {
    return sendError(
      res,
      Object.assign(new Error("duration_min must be between 5 and 1440"), {
        statusCode: 400,
      }),
    );
  }
  if (options.length < 2) {
    return sendError(
      res,
      Object.assign(new Error("at least 2 options are required"), {
        statusCode: 400,
      }),
    );
  }
  if (options.length > 30) {
    return sendError(
      res,
      Object.assign(new Error("at most 30 options allowed"), {
        statusCode: 400,
      }),
    );
  }

  // Validate each option: numeric start/end, end > start, no past-only options
  // (a poll with all options in the past is almost certainly a mistake).
  const now = Date.now();
  let anyFuture = false;
  const normalized = [];
  for (const o of options) {
    const start = Number(o.start_ms);
    // If end isn't provided, derive from duration. Lets the UI send just start.
    const end = Number.isFinite(Number(o.end_ms))
      ? Number(o.end_ms)
      : start + durationMin * 60 * 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return sendError(
        res,
        Object.assign(new Error("invalid option times"), { statusCode: 400 }),
      );
    }
    if (start > now) anyFuture = true;
    normalized.push({ start_ms: start, end_ms: end });
  }
  if (!anyFuture) {
    return sendError(
      res,
      Object.assign(new Error("at least one option must be in the future"), {
        statusCode: 400,
      }),
    );
  }

  const { id } = await insertPollWithOptions({
    tenantId: tenant.id,
    organizerUserId: user.id,
    title,
    description,
    durationMin,
    locationText,
    requireEmail,
    options: normalized,
  });

  const detail = await loadPollDetail(id, { withResponses: false });
  res.statusCode = 201;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(detail));
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await listPolls(req, res);
    if (req.method === "POST") return await createPoll(req, res);
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    sendError(res, err);
  }
}
