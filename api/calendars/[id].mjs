import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";

async function getTenantForUser(db, userId) {
  const r = await db.execute({
    sql: "SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1",
    args: [userId],
  });
  return r.rows[0] || null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const parts = url.pathname.split("/").filter(Boolean);
  const calendarId = parts[parts.length - 1];

  if (req.method === "PATCH") {
    try {
      const { user } = await requireUser(req);
      const db = getDb();
      const tenant = await getTenantForUser(db, user.id);
      if (!tenant) {
        const err = new Error("tenant not found");
        err.statusCode = 404;
        throw err;
      }

      const body = await readJson(req);
      const updates = [];
      const args = [];

      if (typeof body.enabled === "boolean") {
        updates.push("enabled = ?");
        args.push(body.enabled ? 1 : 0);
      }
      if (typeof body.label === "string") {
        updates.push("label = ?");
        args.push(body.label);
      }

      if (updates.length === 0) {
        const err = new Error("no fields to update");
        err.statusCode = 400;
        throw err;
      }

      args.push(calendarId, tenant.id);
      await db.execute({
        sql: `UPDATE calendars SET ${updates.join(", ")} WHERE id = ? AND tenant_id = ?`,
        args,
      });

      const r = await db.execute({
        sql: "SELECT id, tenant_id, oauth_account_id, provider, provider_calendar_id, label, role, enabled FROM calendars WHERE id = ? AND tenant_id = ?",
        args: [calendarId, tenant.id],
      });

      if (!r.rows[0]) {
        const err = new Error("calendar not found");
        err.statusCode = 404;
        throw err;
      }

      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r.rows[0]));
    } catch (err) {
      res.statusCode = err.statusCode || 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "DELETE") {
    try {
      const { user } = await requireUser(req);
      const db = getDb();
      const tenant = await getTenantForUser(db, user.id);
      if (!tenant) {
        const err = new Error("tenant not found");
        err.statusCode = 404;
        throw err;
      }

      await db.execute({
        sql: "DELETE FROM calendars WHERE id = ? AND tenant_id = ?",
        args: [calendarId, tenant.id],
      });

      res.statusCode = 204;
      res.end();
    } catch (err) {
      res.statusCode = err.statusCode || 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.statusCode = 405;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "method not allowed" }));
}
