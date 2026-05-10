/**
 * GET /api/groups/:id/availability?start=ISO&end=ISO[&duration=MIN]
 *
 * Quick "is the family free?" check for the dinner-on-the-15th flow.
 * Required: start, end (or start+duration). Returns conflicting events
 * (tagged with sharer) and a list of busy member ids.
 *
 * The window is capped at 7 days — this isn't meant for long-range
 * planning, just a yes/no on a specific slot.
 */

import { requireUser } from "../../../lib/session.mjs";
import { loadGroupForUser, sendError } from "../../../lib/groups.mjs";
import { computeGroupAvailability } from "../../../lib/group-events.mjs";

const DAY = 24 * 60 * 60 * 1000;

function parseGroupId(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  const idx = segments.indexOf("availability");
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
    const start = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    const durationMin = Number(url.searchParams.get("duration"));

    if (!start) {
      const err = new Error("start (ISO) is required");
      err.statusCode = 400;
      throw err;
    }
    const startMs = Date.parse(start);
    if (!Number.isFinite(startMs)) {
      const err = new Error("start must be a valid ISO timestamp");
      err.statusCode = 400;
      throw err;
    }
    let end;
    if (endParam) {
      end = endParam;
    } else if (Number.isFinite(durationMin) && durationMin > 0) {
      end = new Date(startMs + durationMin * 60 * 1000).toISOString();
    } else {
      const err = new Error("either end or duration (minutes) is required");
      err.statusCode = 400;
      throw err;
    }
    const endMs = Date.parse(end);
    if (endMs <= startMs) {
      const err = new Error("end must be after start");
      err.statusCode = 400;
      throw err;
    }
    if (endMs - startMs > 7 * DAY) {
      const err = new Error("availability window capped at 7 days");
      err.statusCode = 400;
      throw err;
    }

    const result = await computeGroupAvailability({
      groupId,
      viewerUserId: user.id,
      windowStart: start,
      windowEnd: end,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        window: { start, end },
        ...result,
      }),
    );
  } catch (err) {
    sendError(res, err);
  }
}
