import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { getValidAccessToken, listGoogleCalendars } from "../../lib/google.mjs";
import {
  getValidMicrosoftAccessToken,
  listMicrosoftCalendars,
} from "../../lib/microsoft.mjs";

async function getTenantForUser(db, userId) {
  const r = await db.execute({
    sql: "SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1",
    args: [userId],
  });
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  try {
    const { user } = await requireUser(req);
    const db = getDb();
    const tenant = await getTenantForUser(db, user.id);
    if (!tenant) {
      const err = new Error("tenant not found");
      err.statusCode = 404;
      throw err;
    }

    // Get existing calendars in DB for deduplication hints
    const existingRows = await db.execute({
      sql: "SELECT provider, provider_calendar_id, id, enabled FROM calendars WHERE tenant_id = ?",
      args: [tenant.id],
    });
    const existingSet = new Set(
      existingRows.rows.map((r) => `${r.provider}:${r.provider_calendar_id}`),
    );

    const oauthAccounts = await db.execute({
      sql: "SELECT id, provider, email FROM oauth_accounts WHERE tenant_id = ?",
      args: [tenant.id],
    });

    const discovered = [];

    for (const acct of oauthAccounts.rows) {
      try {
        let calendars = [];
        if (acct.provider === "google") {
          const accessToken = await getValidAccessToken(acct);
          calendars = await listGoogleCalendars(accessToken);
        } else if (acct.provider === "microsoft") {
          const accessToken = await getValidMicrosoftAccessToken(acct);
          calendars = await listMicrosoftCalendars(accessToken);
        }

        for (const cal of calendars) {
          const key = `${acct.provider}:${cal.id}`;
          discovered.push({
            provider: acct.provider,
            accountEmail: acct.email,
            oauthAccountId: acct.id,
            providerCalendarId: cal.id,
            summary: cal.summary,
            description: cal.description,
            primary: cal.primary || false,
            accessRole: cal.accessRole,
            alreadyImported: existingSet.has(key),
          });
        }
      } catch (err) {
        // Include error per-account so UI can show it
        discovered.push({
          provider: acct.provider,
          accountEmail: acct.email,
          oauthAccountId: acct.id,
          error: err.message,
        });
      }
    }

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ discovered }));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
}
