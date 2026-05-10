import { randomBytes } from "node:crypto";
import { getDb } from "../../../db/client.mjs";
import { loadSession } from "../../../lib/session.mjs";

const MICROSOFT_AUTH_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

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

  const clientId = process.env.MS_CLIENT_ID;
  const redirectUri = process.env.MS_REDIRECT_URI;
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
      "microsoft",
      tenantId,
      returnTo,
      now,
      now + 10 * 60 * 1000,
    ],
  });

  const scopes = [
    "openid",
    "email",
    "profile",
    "offline_access",
    "Calendars.Read",
    "Calendars.ReadWrite",
    // Contacts autocomplete (parity with Google contacts.readonly).
    // Fetched on-demand into the browser session; not persisted on our
    // servers.
    "Contacts.Read",
  ];

  const authUrl = new URL(MICROSOFT_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  // Microsoft re-prompts whenever requested scopes change — for steady
  // re-login with the same scope list, no prompt parameter is needed
  // and the consent screen is skipped silently. We only force it when
  // the caller explicitly asks (e.g. recovery from a missing refresh
  // token via ?force_consent=1). offline_access is in the scope list
  // above, so refresh tokens are issued on the first grant.
  if (url.searchParams.get("force_consent") === "1") {
    authUrl.searchParams.set("prompt", "consent");
  }

  res.statusCode = 302;
  res.setHeader("location", authUrl.toString());
  res.end();
}
