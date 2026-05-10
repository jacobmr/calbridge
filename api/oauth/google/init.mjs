import { randomBytes } from "node:crypto";
import { getDb } from "../../../db/client.mjs";
import { loadSession } from "../../../lib/session.mjs";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function randomState() {
  return randomBytes(32).toString("base64url");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const baseUrl = process.env.APP_BASE_URL;

  if (!clientId || !redirectUri) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "OAuth not configured" }));
    return;
  }

  const url = new URL(req.url, baseUrl);
  const returnTo = url.searchParams.get("return_to") || "/app/";

  const db = getDb();
  const now = Date.now();

  // Detect already-logged-in user for account-linking flow
  const session = await loadSession(req);
  let tenantId = null;
  let intent = "signup";
  if (session?.userId) {
    const tRow = await db.execute({
      sql: "SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1",
      args: [session.userId],
    });
    if (tRow.rows.length) {
      tenantId = tRow.rows[0].id;
      intent = "link";
    }
  }

  const state = randomState();
  await db.execute({
    sql: "INSERT INTO oauth_states (id, intent, provider, tenant_id, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [
      state,
      intent,
      "google",
      tenantId,
      returnTo,
      now,
      now + 10 * 60 * 1000,
    ],
  });

  const scopes = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    // Contacts autocomplete for the poll-invite / group-invite UIs. Each
    // contact is fetched on-demand and held in the browser session only —
    // we never persist Google contact data on our servers.
    "https://www.googleapis.com/auth/contacts.readonly",
  ];

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  // Tells Google to apply previously-granted scopes silently rather
  // than re-prompt — pairs with omitting prompt=consent below.
  authUrl.searchParams.set("include_granted_scopes", "true");
  // Only force the consent screen when we explicitly need a fresh
  // refresh_token (e.g. token refresh failed and we re-routed the user
  // through OAuth with ?force_consent=1). Without this, returning
  // users authorize silently — the standard pattern for OAuth re-login.
  if (url.searchParams.get("force_consent") === "1") {
    authUrl.searchParams.set("prompt", "consent");
  }

  res.statusCode = 302;
  res.setHeader("location", authUrl.toString());
  res.end();
}
