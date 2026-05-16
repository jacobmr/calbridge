/**
 * GET  /api/polls — list polls owned by the caller's tenant
 * POST /api/polls — create a poll with its candidate options in one shot
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { readJson, sendError } from "../../lib/groups.mjs";
import {
  getTenantForUser,
  insertPollWithOptions,
  loadPollDetail,
} from "../../lib/polls.mjs";
import { sendPollInviteEmail } from "../../lib/email.mjs";
import { enforceLimit } from "../../lib/entitlements.mjs";

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
  const gate = await enforceLimit(tenant.id, "polls");
  if (!gate.allowed) {
    res.statusCode = gate.status;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ error: gate.reason, upgrade: true, plan: gate.plan }),
    );
    return;
  }
  const body = await readJson(req);
  const title = String(body.title || "").trim();
  const description =
    body.description != null ? String(body.description).trim() : null;
  const durationMin = Number(body.duration_min);
  const locationText =
    body.location_text != null ? String(body.location_text).trim() : null;
  // require_email is locked on now — we no longer accept truly anonymous
  // votes. The column stays in the schema for forward compat but every poll
  // is created with email required.
  const requireEmail = true;
  const options = Array.isArray(body.options) ? body.options : [];

  // Optional list of email addresses to send the share-link to. Lightly
  // validated — full RFC checking is overkill; we just want to refuse
  // obvious mistakes and dedupe.
  const inviteEmails = Array.isArray(body.invite_emails)
    ? [
        ...new Set(
          body.invite_emails
            .map((e) =>
              String(e || "")
                .trim()
                .toLowerCase(),
            )
            .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
        ),
      ]
    : [];

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

  const { id, token } = await insertPollWithOptions({
    tenantId: tenant.id,
    organizerUserId: user.id,
    title,
    description,
    durationMin,
    locationText,
    requireEmail,
    options: normalized,
  });

  // Persist + send invitation emails. We do this after the poll is committed
  // so a Resend outage doesn't block the create. Per-address failures are
  // recorded (email_failed_reason) so the organizer can see them.
  let invitesSent = 0;
  let invitesFailed = 0;
  if (inviteEmails.length > 0) {
    const db = getDb();
    const baseUrl = process.env.APP_BASE_URL || "https://www.mical.net";
    const pollUrl = `${baseUrl}/poll/${token}`;

    // Fetch organizer display name for the email "from" line.
    const orgRes = await db.execute({
      sql: "SELECT email, display_name FROM users WHERE id = ? LIMIT 1",
      args: [user.id],
    });
    const organizer = orgRes.rows[0] || {};

    // Insert invite rows first (so we never lose the list even if email
    // dispatch fails partway), then fan out the emails in parallel.
    const inviteIds = new Map();
    for (const email of inviteEmails) {
      const inviteId = randomUUID();
      inviteIds.set(email, inviteId);
      await db.execute({
        sql: `INSERT INTO poll_invites (id, poll_id, email, invited_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(poll_id, email) DO NOTHING`,
        args: [inviteId, id, email, now],
      });
    }

    const sends = await Promise.allSettled(
      inviteEmails.map((email) =>
        sendPollInviteEmail({
          toEmail: email,
          organizerName: organizer.display_name,
          organizerEmail: organizer.email,
          pollTitle: title,
          pollUrl,
        }).then(
          (result) => ({ email, result }),
          (err) => ({ email, error: err }),
        ),
      ),
    );
    for (const settled of sends) {
      const v = settled.value;
      const inviteId = inviteIds.get(v.email);
      if (v.error) {
        invitesFailed++;
        await db.execute({
          sql: "UPDATE poll_invites SET email_failed_reason = ? WHERE id = ?",
          args: [String(v.error.message || v.error).slice(0, 200), inviteId],
        });
      } else if (v.result?.sent) {
        invitesSent++;
        await db.execute({
          sql: "UPDATE poll_invites SET email_sent_at = ? WHERE id = ?",
          args: [Date.now(), inviteId],
        });
      } else {
        invitesFailed++;
        await db.execute({
          sql: "UPDATE poll_invites SET email_failed_reason = ? WHERE id = ?",
          args: [v.result?.reason || "unknown", inviteId],
        });
      }
    }
  }

  const detail = await loadPollDetail(id, { withResponses: false });
  // Surface the invite stats to the UI so the organizer sees how many emails
  // actually went out vs failed (e.g. when RESEND_API_KEY isn't configured,
  // every send returns not_configured and the organizer can fall back to
  // copying the link manually).
  detail.invites_sent = invitesSent;
  detail.invites_failed = invitesFailed;
  detail.invites_total = inviteEmails.length;
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
