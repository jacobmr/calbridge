import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "../db/client.mjs";

// Public-URL token. Same shape as group_invites.token — opaque, unguessable,
// safe to drop into a URL. 24 bytes ≈ 32 base64url chars.
export function mintPollToken() {
  return randomBytes(24).toString("base64url");
}

// Resolve the calling user's tenant. Mirrors the pattern in event-types/index
// (owner first, then any oauth_account membership). Polls always belong to a
// tenant — every signed-in user has one.
export async function getTenantForUser(userId) {
  const db = getDb();
  const owner = await db.execute({
    sql: "SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1",
    args: [userId],
  });
  if (owner.rows[0]) return owner.rows[0];

  const member = await db.execute({
    sql: "SELECT tenant_id AS id FROM oauth_accounts WHERE user_id = ? LIMIT 1",
    args: [userId],
  });
  if (member.rows[0]) return member.rows[0];

  return null;
}

// Convenience to build a poll record from a row + return options + response
// counts in one query batch. Used by GET /api/polls/[id] and the public read.
export async function loadPollDetail(pollId, { withResponses = false } = {}) {
  const db = getDb();
  const pollRes = await db.execute({
    sql: "SELECT * FROM polls WHERE id = ? LIMIT 1",
    args: [pollId],
  });
  const poll = pollRes.rows[0];
  if (!poll) return null;

  const optsRes = await db.execute({
    sql: "SELECT * FROM poll_options WHERE poll_id = ? ORDER BY ord, start_ms",
    args: [pollId],
  });
  const options = optsRes.rows.map((r) => ({
    id: r.id,
    start_ms: Number(r.start_ms),
    end_ms: Number(r.end_ms),
    ord: Number(r.ord),
  }));

  // Count "yes" votes per option for the organizer-facing detail view.
  const tally = new Map(options.map((o) => [o.id, 0]));
  let responses = [];
  if (withResponses) {
    const rRes = await db.execute({
      sql: "SELECT * FROM poll_responses WHERE poll_id = ? ORDER BY created_at",
      args: [pollId],
    });
    responses = rRes.rows.map((r) => {
      const picked = JSON.parse(r.picked_option_ids_json || "[]");
      for (const id of picked) {
        if (tally.has(id)) tally.set(id, tally.get(id) + 1);
      }
      return {
        id: r.id,
        responder_user_id: r.responder_user_id,
        responder_email: r.responder_email,
        responder_name: r.responder_name,
        picked_option_ids: picked,
        comment: r.comment,
        created_at: Number(r.created_at),
        updated_at: Number(r.updated_at),
      };
    });
  }

  return {
    poll: {
      id: poll.id,
      tenant_id: poll.tenant_id,
      organizer_user_id: poll.organizer_user_id,
      title: poll.title,
      description: poll.description,
      duration_min: Number(poll.duration_min),
      location_text: poll.location_text,
      token: poll.token,
      status: poll.status,
      selected_option_id: poll.selected_option_id,
      scheduled_calendar_id: poll.scheduled_calendar_id,
      scheduled_event_id: poll.scheduled_event_id,
      require_email: Number(poll.require_email) === 1,
      closes_at: poll.closes_at ? Number(poll.closes_at) : null,
      created_at: Number(poll.created_at),
      updated_at: Number(poll.updated_at),
    },
    options: options.map((o) => ({ ...o, votes: tally.get(o.id) || 0 })),
    responses,
  };
}

// Insert poll + options atomically. Throws if any DB error; returns the poll id
// + token. options is `[{ start_ms, end_ms }]` — caller validates duration.
export async function insertPollWithOptions({
  tenantId,
  organizerUserId,
  title,
  description,
  durationMin,
  locationText,
  requireEmail,
  options,
}) {
  const db = getDb();
  const id = randomUUID();
  const token = mintPollToken();
  const now = Date.now();

  const tx = await db.transaction("write");
  try {
    await tx.execute({
      sql: `INSERT INTO polls (id, tenant_id, organizer_user_id, title, description,
                               duration_min, location_text, token, status,
                               require_email, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      args: [
        id,
        tenantId,
        organizerUserId,
        title,
        description || null,
        durationMin,
        locationText || null,
        token,
        requireEmail ? 1 : 0,
        now,
        now,
      ],
    });
    let ord = 0;
    for (const opt of options) {
      await tx.execute({
        sql: `INSERT INTO poll_options (id, poll_id, start_ms, end_ms, ord, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [randomUUID(), id, opt.start_ms, opt.end_ms, ord++, now],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return { id, token };
}
