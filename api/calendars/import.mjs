import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { enforceLimit } from "../../lib/entitlements.mjs";

async function getTenantForUser(db, userId) {
  const r = await db.execute({
    sql: "SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1",
    args: [userId],
  });
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
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

    const body = await readJson(req);
    const selections = body.selections || [];
    if (!Array.isArray(selections) || selections.length === 0) {
      const err = new Error("selections array required");
      err.statusCode = 400;
      throw err;
    }

    // Soft gate: only NEW calendars count against the plan cap. Re-
    // importing already-connected calendars (the upsert path below) is
    // always allowed — never block touching existing config. We diff the
    // selection against what's already connected, then check the batch
    // of genuinely-new ones fits the plan.
    const existingRows = await db.execute({
      sql: "SELECT provider_calendar_id FROM calendars WHERE tenant_id = ?",
      args: [tenant.id],
    });
    const already = new Set(
      existingRows.rows.map((r) => r.provider_calendar_id),
    );
    const newCount = selections.filter(
      (s) => !already.has(s.providerCalendarId),
    ).length;
    if (newCount > 0) {
      const gate = await enforceLimit(tenant.id, "calendars", newCount);
      if (!gate.allowed) {
        res.statusCode = gate.status;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: gate.reason,
            upgrade: true,
            plan: gate.plan,
          }),
        );
        return;
      }
    }

    const imported = [];

    for (const sel of selections) {
      const {
        oauthAccountId,
        providerCalendarId,
        summary,
        description,
        accessRole,
      } = sel;

      // Validate ownership
      const acctCheck = await db.execute({
        sql: "SELECT id, tenant_id, provider FROM oauth_accounts WHERE id = ? AND tenant_id = ?",
        args: [oauthAccountId, tenant.id],
      });
      if (!acctCheck.rows[0]) {
        continue; // skip unauthorized
      }

      const provider = acctCheck.rows[0].provider;
      const calId = randomUUID();

      await db.execute({
        sql: `INSERT INTO calendars
          (id, tenant_id, oauth_account_id, provider, provider_calendar_id, label, role, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, provider, provider_calendar_id)
          DO UPDATE SET label = excluded.label, role = excluded.role, enabled = 1`,
        args: [
          calId,
          tenant.id,
          oauthAccountId,
          provider,
          providerCalendarId,
          summary || "Untitled",
          accessRole || "owner",
          1,
        ],
      });

      const existing = await db.execute({
        sql: "SELECT id, tenant_id, oauth_account_id, provider, provider_calendar_id, label, role, enabled FROM calendars WHERE tenant_id = ? AND provider = ? AND provider_calendar_id = ?",
        args: [tenant.id, provider, providerCalendarId],
      });
      if (existing.rows[0]) {
        imported.push(existing.rows[0]);
      }
    }

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ imported }));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid json"));
      }
    });
  });
}
