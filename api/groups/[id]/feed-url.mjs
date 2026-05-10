/**
 * GET /api/groups/:id/feed-url
 *
 * Auth-protected. Returns the signed iCal subscribe URL for the calling
 * user. Splitting this from the public feed endpoint keeps the HMAC
 * generation server-side — the client never derives it.
 */

import { requireUser } from "../../../lib/session.mjs";
import { loadGroupForUser, sendError } from "../../../lib/groups.mjs";
import { feedTokenFor } from "./feed.mjs";

function parseGroupId(req) {
  const url = new URL(req.url, "http://localhost");
  const segs = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  const i = segs.indexOf("feed-url");
  if (i <= 0) return null;
  return segs[i - 1];
}

function appBaseUrl() {
  return process.env.APP_BASE_URL || "https://www.mical.net";
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

    const token = feedTokenFor(groupId, user.id);
    const base = appBaseUrl();
    const httpsUrl = `${base}/api/groups/${groupId}/feed.ics?u=${encodeURIComponent(user.id)}&t=${encodeURIComponent(token)}`;
    // webcal:// is the universal "subscribe me to this calendar" scheme.
    // Same path; calendar apps strip the protocol and re-issue HTTPS.
    const webcalUrl = httpsUrl.replace(/^https?:/, "webcal:");

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ subscribe_url: webcalUrl, download_url: httpsUrl }),
    );
  } catch (err) {
    sendError(res, err);
  }
}
