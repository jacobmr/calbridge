/**
 * GET /api/groups/:id/events?start=ISO&end=ISO
 *
 * Returns the merged event list across all members' shared calendars,
 * filtered by the caller's per-sharer receive_level. See lib/group-events.mjs
 * for the visibility rules.
 *
 * Default window: now - 1 day → now + 14 days. Caller can override.
 */

import { requireUser } from "../../../lib/session.mjs";
import { loadGroupForUser, sendError } from "../../../lib/groups.mjs";
import { fetchGroupEvents } from "../../../lib/group-events.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function parseGroupId(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // /api/groups/<id>/events
  const idx = segments.indexOf("events");
  if (idx <= 0) return null;
  return segments[idx - 1];
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const groupId = parseGroupId(req);
    if (!groupId) {
      const err = new Error("group id required");
      err.statusCode = 400;
      throw err;
    }

    const { user } = await requireUser(req);
    await loadGroupForUser(groupId, user.id);

    const url = new URL(req.url, "http://localhost");
    const now = Date.now();
    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    const timeMin = startParam || new Date(now - DAY).toISOString();
    const timeMax = endParam || new Date(now + 14 * DAY).toISOString();

    // Cap the window to 90 days so a runaway query doesn't fan out across
    // every member's provider — Google/MS both rate-limit per-token.
    const windowMs = Date.parse(timeMax) - Date.parse(timeMin);
    if (!Number.isFinite(windowMs) || windowMs < 0 || windowMs > 90 * DAY) {
      const err = new Error("window must be 0–90 days");
      err.statusCode = 400;
      throw err;
    }

    const events = await fetchGroupEvents({
      groupId,
      viewerUserId: user.id,
      timeMin,
      timeMax,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        timeMin,
        timeMax,
        events,
      }),
    );
  } catch (err) {
    sendError(res, err);
  }
}
