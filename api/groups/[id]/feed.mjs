/**
 * GET /api/groups/:id/feed.ics?u=<userId>&t=<hmac>
 *
 * Returns a text/calendar feed of merged group events for one viewer. The
 * HMAC signs (groupId + userId) with INTERNAL_DISPATCH_HMAC so subscribers
 * (Google Calendar, Apple, Outlook) can fetch without a session cookie.
 *
 * Why HMAC and not session: calendar apps refresh the URL on a schedule
 * and don't carry browser cookies. The token is unguessable and scoped
 * to one user / one group. To "revoke", the user removes themselves from
 * the group (or the group is deleted) — both make subsequent fetches 404.
 *
 * The dashboard composes the URL via /api/groups/:id/feed-url, which
 * requires session auth and returns the signed URL.
 */

import { createHmac } from "node:crypto";
import { getDb } from "../../../db/client.mjs";
import { fetchGroupEvents } from "../../../lib/group-events.mjs";
import { buildIcs } from "../../../lib/ical.mjs";

const FEED_WINDOW_DAYS_BACK = 7;
const FEED_WINDOW_DAYS_FORWARD = 60;

function parseGroupId(req) {
  const url = new URL(req.url, "http://localhost");
  const segs = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // .../groups/<id>/feed.ics
  const i = segs.findIndex((s) => s === "feed.ics" || s === "feed");
  if (i <= 0) return null;
  return segs[i - 1];
}

export function feedTokenFor(groupId, userId) {
  const secret = process.env.INTERNAL_DISPATCH_HMAC;
  if (!secret) throw new Error("INTERNAL_DISPATCH_HMAC not set");
  return createHmac("sha256", secret)
    .update(`${groupId}:${userId}`)
    .digest("base64url");
}

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++)
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("content-type", "text/plain");
      res.end("method not allowed");
      return;
    }

    const groupId = parseGroupId(req);
    const url = new URL(req.url, "http://localhost");
    const userId = url.searchParams.get("u");
    const token = url.searchParams.get("t");
    if (!groupId || !userId || !token) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain");
      res.end("missing params");
      return;
    }

    const expected = feedTokenFor(groupId, userId);
    if (!constantTimeEquals(token, expected)) {
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain");
      res.end("invalid token");
      return;
    }

    // Confirm the user is still an active member; if removed, the feed
    // 404s rather than 403 — matches the privacy posture in /api/groups/:id.
    const db = getDb();
    const m = await db.execute({
      sql: `SELECT 1 FROM group_memberships
             WHERE group_id = ? AND user_id = ? AND status = 'active'
             LIMIT 1`,
      args: [groupId, userId],
    });
    if (!m.rows[0]) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      res.end("not found");
      return;
    }

    const g = await db.execute({
      sql: "SELECT name FROM groups WHERE id = ?",
      args: [groupId],
    });
    const groupName = g.rows[0]?.name || "Group schedule";

    const now = Date.now();
    const timeMin = new Date(
      now - FEED_WINDOW_DAYS_BACK * 86400000,
    ).toISOString();
    const timeMax = new Date(
      now + FEED_WINDOW_DAYS_FORWARD * 86400000,
    ).toISOString();

    const events = await fetchGroupEvents({
      groupId,
      viewerUserId: userId,
      timeMin,
      timeMax,
    });

    const ics = buildIcs({
      calendarName: `${groupName} · MiCal`,
      events,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "text/calendar; charset=utf-8");
    res.setHeader(
      "content-disposition",
      `inline; filename="${groupName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.ics"`,
    );
    // Cache aggressively — calendar apps refresh on their own schedule;
    // we just want one less roundtrip if they ping twice.
    res.setHeader("cache-control", "public, max-age=300, s-maxage=300");
    res.end(ics);
  } catch (e) {
    res.statusCode = e.statusCode || 500;
    res.setHeader("content-type", "text/plain");
    res.end(e.message || "server error");
  }
}
