import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { getValidAccessToken, listGoogleCalendars } from "../../lib/google.mjs";

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

    const oauthRows = await db.execute({
      sql: "SELECT id, tenant_id, refresh_token_enc, access_token_enc, access_token_expires_at FROM oauth_accounts WHERE tenant_id = ? AND provider = ?",
      args: [tenant.id, "google"],
    });

    const synced = [];

    for (const acct of oauthRows.rows) {
      const accessToken = await getValidAccessToken(acct);
      const googleCals = await listGoogleCalendars(accessToken);

      for (const gcal of googleCals) {
        const calId = randomUUID();
        await db.execute({
          sql: `INSERT INTO calendars
            (id, tenant_id, oauth_account_id, provider, provider_calendar_id, label, role, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, provider, provider_calendar_id)
            DO UPDATE SET label = excluded.label, role = excluded.role`,
          args: [
            calId,
            tenant.id,
            acct.id,
            "google",
            gcal.id,
            gcal.summary,
            gcal.accessRole,
            1,
          ],
        });

        const existing = await db.execute({
          sql: "SELECT id, tenant_id, oauth_account_id, provider, provider_calendar_id, label, role, enabled FROM calendars WHERE tenant_id = ? AND provider = ? AND provider_calendar_id = ?",
          args: [tenant.id, "google", gcal.id],
        });
        if (existing.rows[0]) {
          synced.push(existing.rows[0]);
        }
      }
    }

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(synced));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
}
