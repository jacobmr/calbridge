/**
 * Public poll API — token-gated, no session required.
 *
 *   GET  /api/polls/public?token=<token>
 *     Returns poll metadata, options, viewer info (if a session cookie is
 *     present), and the viewer's existing response if any. In stage 3 this
 *     endpoint also marks each option busy/free for signed-in viewers using
 *     their connected calendars.
 *
 *   POST /api/polls/public
 *     Body: { token, name, email?, picked_option_ids, comment? }
 *     Idempotent. (poll, user_id) and (poll, email) are unique — repeat
 *     submissions UPDATE the existing row in place.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.mjs";
import { loadSession } from "../../lib/session.mjs";
import { readJson, sendError } from "../../lib/groups.mjs";
import { freeBusyForUser } from "../../lib/user-availability.mjs";

async function getPublicPoll(req, res) {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  if (!token) {
    return sendError(
      res,
      Object.assign(new Error("token required"), { statusCode: 400 }),
    );
  }
  const db = getDb();
  const pollRes = await db.execute({
    sql: "SELECT * FROM polls WHERE token = ? LIMIT 1",
    args: [token],
  });
  const poll = pollRes.rows[0];
  if (!poll) {
    return sendError(
      res,
      Object.assign(new Error("poll not found"), { statusCode: 404 }),
    );
  }

  const optsRes = await db.execute({
    sql: "SELECT id, start_ms, end_ms, ord FROM poll_options WHERE poll_id = ? ORDER BY ord, start_ms",
    args: [poll.id],
  });
  const options = optsRes.rows.map((o) => ({
    id: o.id,
    start_ms: Number(o.start_ms),
    end_ms: Number(o.end_ms),
    // busy left undefined here; stage 3 fills it for signed-in viewers.
  }));

  // Look up the organizer name (the signature on the poll). Falls back to
  // tenant name if the user has no display name set.
  const orgRes = await db.execute({
    sql: `SELECT u.display_name, u.email, t.name AS tenant_name
            FROM users u JOIN tenants t ON t.owner_user_id = u.id
           WHERE u.id = ? LIMIT 1`,
    args: [poll.organizer_user_id],
  });
  const org = orgRes.rows[0] || {};
  const organizerName =
    org.display_name ||
    org.tenant_name ||
    (org.email || "").split("@")[0] ||
    "MiCal user";

  // Opportunistic session — anonymous if absent. We use the session both to
  // look up the viewer's existing response and to mark each option busy or
  // free against their connected calendars (the headline differentiator).
  let viewer = { signed_in: false };
  let myResponse = null;
  const session = await loadSession(req);
  if (session?.userId) {
    const uRes = await db.execute({
      sql: "SELECT id, email, display_name FROM users WHERE id = ? LIMIT 1",
      args: [session.userId],
    });
    const u = uRes.rows[0];
    if (u) {
      viewer = {
        signed_in: true,
        user_id: u.id,
        email: u.email,
        name: u.display_name,
      };
      const resp = await db.execute({
        sql: "SELECT * FROM poll_responses WHERE poll_id = ? AND responder_user_id = ? LIMIT 1",
        args: [poll.id, u.id],
      });
      if (resp.rows[0]) {
        myResponse = formatResponse(resp.rows[0]);
      }

      // Pre-check: mark each option busy/free against the viewer's calendars.
      // Failure here is non-fatal — falling back to undefined leaves the pills
      // unrendered, identical to the anonymous experience. Better than failing
      // the whole page when a provider is flaky. Log so we can see it in
      // Vercel function logs without surfacing the noise to the user.
      try {
        const busy = await freeBusyForUser({
          userId: u.id,
          windows: options.map((o) => ({
            start_ms: o.start_ms,
            end_ms: o.end_ms,
          })),
        });
        for (let i = 0; i < options.length; i++) options[i].busy = busy[i];
      } catch (err) {
        console.error("poll free/busy pre-check failed:", err.message);
      }
    }
  }

  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      poll: {
        id: poll.id,
        title: poll.title,
        description: poll.description,
        duration_min: Number(poll.duration_min),
        location_text: poll.location_text,
        token: poll.token,
        status: poll.status,
        require_email: Number(poll.require_email) === 1,
        organizer_name: organizerName,
        scheduled_option_id: poll.selected_option_id || null,
      },
      options,
      viewer,
      my_response: myResponse,
    }),
  );
}

function formatResponse(row) {
  return {
    id: row.id,
    name: row.responder_name,
    email: row.responder_email,
    user_id: row.responder_user_id,
    picked_option_ids: JSON.parse(row.picked_option_ids_json || "[]"),
    comment: row.comment,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

async function postPublicVote(req, res) {
  const body = await readJson(req);
  const token = String(body.token || "");
  const name = body.name ? String(body.name).trim() : null;
  const email = body.email ? String(body.email).trim().toLowerCase() : null;
  const comment = body.comment ? String(body.comment).trim() : null;
  const picked = Array.isArray(body.picked_option_ids)
    ? body.picked_option_ids.map(String)
    : [];

  if (!token) {
    return sendError(
      res,
      Object.assign(new Error("token required"), { statusCode: 400 }),
    );
  }
  if (picked.length === 0) {
    return sendError(
      res,
      Object.assign(
        new Error(
          "pick at least one slot, even if everything is bad — or skip the form",
        ),
        {
          statusCode: 400,
        },
      ),
    );
  }

  const db = getDb();
  const pollRes = await db.execute({
    sql: "SELECT * FROM polls WHERE token = ? LIMIT 1",
    args: [token],
  });
  const poll = pollRes.rows[0];
  if (!poll) {
    return sendError(
      res,
      Object.assign(new Error("poll not found"), { statusCode: 404 }),
    );
  }
  if (poll.status !== "open") {
    return sendError(
      res,
      Object.assign(new Error(`poll is ${poll.status}`), { statusCode: 400 }),
    );
  }

  // Every vote must be tied to either a session (signed-in user) or an
  // email — fully anonymous votes were retired in v1.1. Without an
  // identifier we have no way to notify the responder of the winner and
  // no way to deduplicate repeated votes.
  const session = await loadSession(req);
  const userId = session?.userId || null;
  if (!email && !userId) {
    return sendError(
      res,
      Object.assign(new Error("sign in or provide an email to vote"), {
        statusCode: 400,
      }),
    );
  }

  // Validate that every picked id actually belongs to this poll. Drops
  // stale option ids silently rather than erroring — it's possible the
  // organizer edited the option list between the page load and submit.
  const optsRes = await db.execute({
    sql: "SELECT id FROM poll_options WHERE poll_id = ?",
    args: [poll.id],
  });
  const validIds = new Set(optsRes.rows.map((r) => r.id));
  const filtered = picked.filter((id) => validIds.has(id));
  if (filtered.length === 0) {
    return sendError(
      res,
      Object.assign(new Error("none of the selected times are valid"), {
        statusCode: 400,
      }),
    );
  }

  // Upsert by (poll, user_id) when signed in, else by (poll, email). This
  // matches the partial unique indexes on the table — we won't get a unique-
  // constraint violation as long as we look up first and UPDATE on hit.
  const now = Date.now();
  const pickedJson = JSON.stringify(filtered);

  let existing = null;
  if (userId) {
    const r = await db.execute({
      sql: "SELECT id FROM poll_responses WHERE poll_id = ? AND responder_user_id = ? LIMIT 1",
      args: [poll.id, userId],
    });
    existing = r.rows[0];
  } else if (email) {
    const r = await db.execute({
      sql: "SELECT id FROM poll_responses WHERE poll_id = ? AND responder_email = ? LIMIT 1",
      args: [poll.id, email],
    });
    existing = r.rows[0];
  }

  let responseId;
  if (existing) {
    responseId = existing.id;
    await db.execute({
      sql: `UPDATE poll_responses
               SET responder_name = ?, responder_email = ?, picked_option_ids_json = ?,
                   comment = ?, updated_at = ?
             WHERE id = ?`,
      args: [name, email, pickedJson, comment, now, responseId],
    });
  } else {
    responseId = randomUUID();
    await db.execute({
      sql: `INSERT INTO poll_responses
              (id, poll_id, responder_user_id, responder_email, responder_name,
               picked_option_ids_json, comment, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        responseId,
        poll.id,
        userId,
        email,
        name,
        pickedJson,
        comment,
        now,
        now,
      ],
    });
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      response_id: responseId,
      picked_option_ids: filtered,
    }),
  );
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await getPublicPoll(req, res);
    if (req.method === "POST") return await postPublicVote(req, res);
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    sendError(res, err);
  }
}
