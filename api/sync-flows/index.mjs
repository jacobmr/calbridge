import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";

function parsePathId(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  // pathname is like /api/sync-flows or /api/sync-flows/abc
  return segments.length > 2 ? segments[segments.length - 1] : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function getTenantForUser(userId) {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT id FROM tenants WHERE owner_user_id = ?",
    args: [userId],
  });
  return r.rows[0] || null;
}

async function listSyncFlows(req, res) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }

  const db = getDb();
  // Subquery picks the most recent run per flow (started_at DESC, then by id
  // for determinism on ties). LEFT JOIN so flows that have never run still
  // appear with last_run_* fields = null.
  const r = await db.execute({
    sql: `
      SELECT
        sf.id,
        sf.tenant_id,
        sf.source_calendar_id,
        sf.target_calendar_id,
        sf.options_json,
        sf.enabled,
        sf.ord,
        sc.label AS source_calendar_label,
        tc.label AS target_calendar_label,
        sr.started_at  AS last_run_at,
        sr.finished_at AS last_run_finished_at,
        sr.ok          AS last_run_ok,
        sr.totals_json AS last_run_totals_json
      FROM sync_flows sf
      LEFT JOIN calendars sc ON sc.id = sf.source_calendar_id
      LEFT JOIN calendars tc ON tc.id = sf.target_calendar_id
      LEFT JOIN (
        SELECT sync_flow_id, started_at, finished_at, ok, totals_json,
               ROW_NUMBER() OVER (PARTITION BY sync_flow_id ORDER BY started_at DESC) AS rn
        FROM sync_runs
        WHERE sync_flow_id IS NOT NULL
      ) sr ON sr.sync_flow_id = sf.id AND sr.rn = 1
      WHERE sf.tenant_id = ?
      ORDER BY sf.ord
    `,
    args: [tenant.id],
  });

  const flows = r.rows.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    source_calendar_id: row.source_calendar_id,
    target_calendar_id: row.target_calendar_id,
    options_json: row.options_json,
    enabled: row.enabled,
    ord: row.ord,
    source_calendar_label: row.source_calendar_label,
    target_calendar_label: row.target_calendar_label,
    last_run_at: row.last_run_at != null ? Number(row.last_run_at) : null,
    last_run_finished_at:
      row.last_run_finished_at != null ? Number(row.last_run_finished_at) : null,
    last_run_ok: row.last_run_ok != null ? row.last_run_ok === 1 : null,
    last_run_totals: row.last_run_totals_json
      ? safeParseJson(row.last_run_totals_json)
      : null,
  }));

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(flows));
}

function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function createSyncFlow(req, res) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }

  const body = await readBody(req);
  const { source_calendar_id, target_calendar_id, options_json, enabled, ord } =
    body;

  if (!source_calendar_id || !target_calendar_id) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: "source_calendar_id and target_calendar_id are required",
      }),
    );
    return;
  }

  const db = getDb();

  // Verify both calendars exist and belong to the tenant
  const cals = await db.execute({
    sql: "SELECT id FROM calendars WHERE id IN (?, ?) AND tenant_id = ?",
    args: [source_calendar_id, target_calendar_id, tenant.id],
  });
  if (cals.rows.length !== 2) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid calendar ids" }));
    return;
  }

  const id = randomUUID();
  await db.execute({
    sql: `
      INSERT INTO sync_flows
        (id, tenant_id, source_calendar_id, target_calendar_id, options_json, enabled, ord)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      tenant.id,
      source_calendar_id,
      target_calendar_id,
      options_json != null ? JSON.stringify(options_json) : null,
      enabled != null ? (enabled ? 1 : 0) : 1,
      ord != null ? Number(ord) : 0,
    ],
  });

  const r = await db.execute({
    sql: `
      SELECT
        sf.id,
        sf.tenant_id,
        sf.source_calendar_id,
        sf.target_calendar_id,
        sf.options_json,
        sf.enabled,
        sf.ord,
        sc.label AS source_calendar_label,
        tc.label AS target_calendar_label
      FROM sync_flows sf
      LEFT JOIN calendars sc ON sc.id = sf.source_calendar_id
      LEFT JOIN calendars tc ON tc.id = sf.target_calendar_id
      WHERE sf.id = ?
    `,
    args: [id],
  });

  const row = r.rows[0];
  const flow = {
    id: row.id,
    tenant_id: row.tenant_id,
    source_calendar_id: row.source_calendar_id,
    target_calendar_id: row.target_calendar_id,
    options_json: row.options_json,
    enabled: row.enabled,
    ord: row.ord,
    source_calendar_label: row.source_calendar_label,
    target_calendar_label: row.target_calendar_label,
  };

  res.statusCode = 201;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(flow));
}

async function updateSyncFlow(req, res, id) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }

  const db = getDb();

  // Verify flow exists and belongs to tenant
  const existing = await db.execute({
    sql: "SELECT id FROM sync_flows WHERE id = ? AND tenant_id = ?",
    args: [id, tenant.id],
  });
  if (!existing.rows[0]) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "sync flow not found" }));
    return;
  }

  const body = await readBody(req);
  const updates = [];
  const args = [];

  if (body.options_json !== undefined) {
    updates.push("options_json = ?");
    args.push(JSON.stringify(body.options_json));
  }
  if (body.enabled !== undefined) {
    updates.push("enabled = ?");
    args.push(body.enabled ? 1 : 0);
  }
  if (body.ord !== undefined) {
    updates.push("ord = ?");
    args.push(Number(body.ord));
  }

  if (updates.length === 0) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "no fields to update" }));
    return;
  }

  args.push(id);
  await db.execute({
    sql: `UPDATE sync_flows SET ${updates.join(", ")} WHERE id = ?`,
    args,
  });

  const r = await db.execute({
    sql: `
      SELECT
        sf.id,
        sf.tenant_id,
        sf.source_calendar_id,
        sf.target_calendar_id,
        sf.options_json,
        sf.enabled,
        sf.ord,
        sc.label AS source_calendar_label,
        tc.label AS target_calendar_label
      FROM sync_flows sf
      LEFT JOIN calendars sc ON sc.id = sf.source_calendar_id
      LEFT JOIN calendars tc ON tc.id = sf.target_calendar_id
      WHERE sf.id = ?
    `,
    args: [id],
  });

  const row = r.rows[0];
  const flow = {
    id: row.id,
    tenant_id: row.tenant_id,
    source_calendar_id: row.source_calendar_id,
    target_calendar_id: row.target_calendar_id,
    options_json: row.options_json,
    enabled: row.enabled,
    ord: row.ord,
    source_calendar_label: row.source_calendar_label,
    target_calendar_label: row.target_calendar_label,
  };

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(flow));
}

async function deleteSyncFlow(req, res, id) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }

  const db = getDb();

  // Verify flow exists and belongs to tenant
  const existing = await db.execute({
    sql: "SELECT id FROM sync_flows WHERE id = ? AND tenant_id = ?",
    args: [id, tenant.id],
  });
  if (!existing.rows[0]) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "sync flow not found" }));
    return;
  }

  await db.execute({
    sql: "DELETE FROM sync_flows WHERE id = ?",
    args: [id],
  });

  res.statusCode = 204;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}

export default async function handler(req, res) {
  try {
    const id = parsePathId(req);

    if (!id) {
      if (req.method === "GET") {
        await listSyncFlows(req, res);
        return;
      }
      if (req.method === "POST") {
        await createSyncFlow(req, res);
        return;
      }
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    if (req.method === "PATCH") {
      await updateSyncFlow(req, res, id);
      return;
    }
    if (req.method === "DELETE") {
      await deleteSyncFlow(req, res, id);
      return;
    }

    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
}
