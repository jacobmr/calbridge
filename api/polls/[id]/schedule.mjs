/**
 * POST /api/polls/[id]/schedule
 *   Body: { option_id, calendar_id }
 *
 * Picks the winner of a poll: creates a real calendar event on the
 * organizer's chosen calendar (with all responders as attendees + Google
 * Meet auto-attached when the calendar is Google), flips the poll's status
 * to 'scheduled', and emails every responder via Resend.
 *
 * Failure modes:
 *  - calendar create fails → poll stays open, error surfaces, nothing else
 *    has changed yet.
 *  - DB update fails after event create → poll status not updated, but the
 *    event exists; organizer can manually delete it. Logged.
 *  - email send fails → surfaced in the response totals but doesn't roll
 *    back the schedule. Resend itself silently no-ops if the API key
 *    isn't set, which is the right behavior for self-hosted deployments.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../../db/client.mjs";
import { requireUser } from "../../../lib/session.mjs";
import { readJson, sendError } from "../../../lib/groups.mjs";
import { getProviderClientForCalendar } from "../../../lib/providers/index.mjs";
import { sendPollWinnerEmail } from "../../../lib/email.mjs";
import { getTenantForUser } from "../../../lib/polls.mjs";

function parsePollId(req) {
  const url = new URL(req.url, "http://localhost");
  const m = url.pathname.match(/\/api\/polls\/([^/?#]+)/);
  return m ? m[1] : null;
}

function fmtWhen(startMs, durationMin, tz) {
  const start = new Date(startMs);
  const opts = {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz || undefined,
    timeZoneName: "short",
  };
  return `${start.toLocaleString("en-US", opts)} (${durationMin} min)`;
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
    const body = await readJson(req);
    const optionId = String(body.option_id || "");
    const calendarId = String(body.calendar_id || "");
    if (!optionId || !calendarId) {
      return sendError(
        res,
        Object.assign(new Error("option_id and calendar_id are required"), {
          statusCode: 400,
        }),
      );
    }

    const db = getDb();

    // Authorize: poll exists in the user's tenant, the user is the organizer,
    // and the status is still pickable. Tenant scoping mirrors the rest of
    // the polls endpoints — defense in depth so a leaked id never crosses a
    // tenant boundary.
    const tenant = await getTenantForUser(user.id);
    if (!tenant) {
      return sendError(
        res,
        Object.assign(new Error("tenant not found"), { statusCode: 404 }),
      );
    }
    const pollRes = await db.execute({
      sql: "SELECT * FROM polls WHERE id = ? AND tenant_id = ? LIMIT 1",
      args: [id, tenant.id],
    });
    const poll = pollRes.rows[0];
    if (!poll) {
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
    if (poll.status === "scheduled") {
      return sendError(
        res,
        Object.assign(new Error("poll is already scheduled"), {
          statusCode: 400,
        }),
      );
    }
    if (poll.status === "cancelled") {
      return sendError(
        res,
        Object.assign(new Error("poll is cancelled"), { statusCode: 400 }),
      );
    }

    // Validate the option belongs to the poll.
    const optRes = await db.execute({
      sql: "SELECT * FROM poll_options WHERE id = ? AND poll_id = ? LIMIT 1",
      args: [optionId, id],
    });
    const option = optRes.rows[0];
    if (!option) {
      return sendError(
        res,
        Object.assign(new Error("option not found in this poll"), {
          statusCode: 404,
        }),
      );
    }

    // Validate the target calendar belongs to the organizer and can write.
    const calRes = await db.execute({
      sql: "SELECT * FROM calendars WHERE id = ? AND owner_user_id = ? LIMIT 1",
      args: [calendarId, user.id],
    });
    const cal = calRes.rows[0];
    if (!cal) {
      return sendError(
        res,
        Object.assign(new Error("calendar not found"), { statusCode: 404 }),
      );
    }
    const provider = String(cal.provider || "").toLowerCase();
    if (provider === "ics") {
      return sendError(
        res,
        Object.assign(new Error("can't schedule on a read-only ICS feed"), {
          statusCode: 400,
        }),
      );
    }

    // Tenant TZ for the event time zone.
    const tRes = await db.execute({
      sql: "SELECT default_tz FROM tenants WHERE id = ? LIMIT 1",
      args: [poll.tenant_id],
    });
    const tenantTz = tRes.rows[0]?.default_tz || "UTC";

    // Collect all responders + their email/user_id for the attendee list and
    // the winner notification. Dedupe on email — duplicate addresses across
    // signed-in / anonymous responses produce a single invite.
    const respRes = await db.execute({
      sql: `SELECT pr.responder_user_id, pr.responder_email, pr.responder_name,
                   u.email AS user_email, u.display_name AS user_display
              FROM poll_responses pr
              LEFT JOIN users u ON u.id = pr.responder_user_id
             WHERE pr.poll_id = ?`,
      args: [id],
    });
    const recipients = new Map(); // email → { email, name }
    for (const r of respRes.rows) {
      const email = (r.responder_email || r.user_email || "")
        .trim()
        .toLowerCase();
      if (!email) continue;
      if (!recipients.has(email)) {
        recipients.set(email, {
          email,
          name: r.responder_name || r.user_display || null,
        });
      }
    }

    // Organizer's email — used as the event's organizer/replyTo.
    const orgRes = await db.execute({
      sql: "SELECT email, display_name FROM users WHERE id = ? LIMIT 1",
      args: [user.id],
    });
    const organizer = orgRes.rows[0] || {};

    // Build the event payload. Mirrors api/book/public.mjs's event-create
    // path: ISO start/end, attendees list, conditional Meet auto-attach for
    // Google. We don't need to pass a separate location for Meet — the link
    // ends up on the event automatically.
    const startMs = Number(option.start_ms);
    const endMs = Number(option.end_ms);
    const startISO = new Date(startMs).toISOString();
    const endISO = new Date(endMs).toISOString();
    const attendees = [...recipients.values()].map((r) => ({
      email: r.email,
      displayName: r.name || undefined,
    }));

    const eventPayload = {
      summary: poll.title,
      description: poll.description || "",
      start: { dateTime: startISO, timeZone: tenantTz },
      end: { dateTime: endISO, timeZone: tenantTz },
      attendees,
    };
    if (poll.location_text) eventPayload.location = poll.location_text;

    // Auto-attach a Google Meet when the host is on Google AND there's no
    // location set already (otherwise the explicit location wins). Mirrors
    // the booking-page rule but defaults on for polls — most poll meetings
    // are remote anyway.
    if (provider === "google" && !poll.location_text) {
      eventPayload.conferenceData = {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    let providerEventId = null;
    try {
      const client = await getProviderClientForCalendar(cal);
      if (!client.capabilities.canWrite) {
        throw new Error("calendar is read-only");
      }
      const created = await client.createEvent(
        cal.provider_calendar_id,
        eventPayload,
      );
      providerEventId = created?.id || null;
    } catch (e) {
      return sendError(
        res,
        Object.assign(
          new Error(`couldn't create the event: ${e.message || String(e)}`),
          { statusCode: 502 },
        ),
      );
    }

    // Mark the poll scheduled. From this point on the calendar event exists
    // even if we fail; we log and surface the partial state.
    const now = Date.now();
    await db.execute({
      sql: `UPDATE polls
               SET status = 'scheduled',
                   selected_option_id = ?,
                   scheduled_calendar_id = ?,
                   scheduled_event_id = ?,
                   updated_at = ?
             WHERE id = ?`,
      args: [optionId, calendarId, providerEventId, now, id],
    });

    // Fire winner emails. We send one per recipient and tally successes /
    // failures so the organizer knows whether everyone got the message.
    const baseUrl = process.env.APP_BASE_URL || "https://www.mical.net";
    const pollUrl = `${baseUrl}/poll/${poll.token}`;
    const whenLabel = fmtWhen(startMs, Number(poll.duration_min), tenantTz);
    // Fan out the Resend calls in parallel so total latency is one round-trip
    // instead of N. allSettled because one bad email shouldn't tank the rest.
    const emailResults = await Promise.allSettled(
      [...recipients.values()].map((r) =>
        sendPollWinnerEmail({
          toEmail: r.email,
          recipientName: r.name,
          organizerName: organizer.display_name,
          organizerEmail: organizer.email,
          pollTitle: poll.title,
          whenLabel,
          locationText: poll.location_text,
          pollUrl,
        }).then(
          (result) => ({ email: r.email, result }),
          (err) => ({ email: r.email, error: err }),
        ),
      ),
    );
    let emailsSent = 0;
    let emailsFailed = 0;
    for (const settled of emailResults) {
      const v = settled.value; // both branches resolve, never reject
      if (v.error) {
        emailsFailed++;
        console.error("poll winner email failed:", v.email, v.error.message);
      } else if (v.result?.sent) {
        emailsSent++;
      } else {
        emailsFailed++;
      }
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        poll_id: id,
        selected_option_id: optionId,
        scheduled_event_id: providerEventId,
        emails_sent: emailsSent,
        emails_failed: emailsFailed,
        recipients: recipients.size,
      }),
    );
  } catch (err) {
    sendError(res, err);
  }
}
