/**
 * POST /api/polls/[id]/close — stop accepting new votes.
 *
 * Closing is reversible (the organizer can re-open by calling PATCH with
 * status='open' once we expose that — for now, deletion is the only undo).
 * Idempotent: closing an already-closed poll is a no-op success.
 */

import { getDb } from "../../../db/client.mjs";
import { requireUser } from "../../../lib/session.mjs";
import { sendError } from "../../../lib/groups.mjs";
import { getTenantForUser, loadPollDetail } from "../../../lib/polls.mjs";

function parsePollId(req) {
  const url = new URL(req.url, "http://localhost");
  const m = url.pathname.match(/\/api\/polls\/([^/?#]+)/);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const { user } = await requireUser(req);
    const id = parsePollId(req);
    if (!id) {
      return sendError(
        res,
        Object.assign(new Error("missing poll id"), { statusCode: 400 }),
      );
    }
    const tenant = await getTenantForUser(user.id);
    if (!tenant) {
      return sendError(
        res,
        Object.assign(new Error("tenant not found"), { statusCode: 404 }),
      );
    }
    const db = getDb();
    const row = await db.execute({
      sql: "SELECT * FROM polls WHERE id = ? LIMIT 1",
      args: [id],
    });
    const poll = row.rows[0];
    if (!poll || poll.tenant_id !== tenant.id) {
      return sendError(
        res,
        Object.assign(new Error("poll not found"), { statusCode: 404 }),
      );
    }
    if (poll.organizer_user_id !== user.id) {
      return sendError(
        res,
        Object.assign(new Error("not the organizer"), { statusCode: 403 }),
      );
    }
    if (poll.status === "scheduled" || poll.status === "cancelled") {
      return sendError(
        res,
        Object.assign(new Error(`cannot close a ${poll.status} poll`), {
          statusCode: 400,
        }),
      );
    }
    if (poll.status !== "closed") {
      await db.execute({
        sql: "UPDATE polls SET status = 'closed', updated_at = ? WHERE id = ?",
        args: [Date.now(), id],
      });
    }
    const detail = await loadPollDetail(id, { withResponses: true });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(detail));
  } catch (err) {
    sendError(res, err);
  }
}
