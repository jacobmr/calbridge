import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { enforceLimit } from "../../lib/entitlements.mjs";

function parsePathId(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
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
  const owner = await db.execute({
    sql: "SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1",
    args: [userId],
  });
  if (owner.rows[0]) return owner.rows[0];

  const member = await db.execute({
    sql: "SELECT tenant_id AS id FROM oauth_accounts WHERE user_id = ? LIMIT 1",
    args: [userId],
  });
  if (member.rows[0]) return member.rows[0];

  return null;
}

function isUrlSafeSlug(slug) {
  return /^[a-z0-9_-]+$/i.test(slug);
}

async function listEventTypes(req, res) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }

  const db = getDb();
  const r = await db.execute({
    sql: "SELECT * FROM event_types WHERE tenant_id = ? ORDER BY name",
    args: [tenant.id],
  });

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(r.rows));
}

async function createEventType(req, res) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }

  const gate = await enforceLimit(tenant.id, "eventTypes");
  if (!gate.allowed) {
    res.statusCode = gate.status;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ error: gate.reason, upgrade: true, plan: gate.plan }),
    );
    return;
  }

  const body = await readBody(req);
  const {
    slug,
    name,
    duration_min,
    buffer_min,
    lead_min,
    horizon_days,
    weekdays_mask,
    work_hours_json,
    target_calendar_id,
    location_mode,
    require_email,
    pass_required,
    pass_hash,
    branding_json,
    enabled,
  } = body;

  if (
    !slug ||
    !name ||
    duration_min == null ||
    !work_hours_json ||
    !target_calendar_id
  ) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "missing required fields" }));
    return;
  }

  if (!isUrlSafeSlug(slug)) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "slug must be URL-safe" }));
    return;
  }

  const db = getDb();

  const calCheck = await db.execute({
    sql: "SELECT id FROM calendars WHERE id = ? AND tenant_id = ?",
    args: [target_calendar_id, tenant.id],
  });
  if (!calCheck.rows[0]) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "calendar not found" }));
    return;
  }

  const slugCheck = await db.execute({
    sql: "SELECT id FROM event_types WHERE tenant_id = ? AND slug = ?",
    args: [tenant.id, slug],
  });
  if (slugCheck.rows[0]) {
    res.statusCode = 409;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "slug already exists" }));
    return;
  }

  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO event_types (
      id, tenant_id, slug, name, duration_min, buffer_min, lead_min,
      horizon_days, weekdays_mask, work_hours_json, target_calendar_id,
      location_mode, require_email, pass_required, pass_hash, branding_json, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      tenant.id,
      slug,
      name,
      duration_min,
      buffer_min ?? 0,
      lead_min ?? 0,
      horizon_days ?? 25,
      weekdays_mask ?? 31,
      work_hours_json,
      target_calendar_id,
      location_mode ?? "meet",
      require_email ?? 1,
      pass_required ?? 0,
      pass_hash ?? null,
      branding_json ?? null,
      enabled ?? 1,
    ],
  });

  const r = await db.execute({
    sql: "SELECT * FROM event_types WHERE id = ?",
    args: [id],
  });
  res.statusCode = 201;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(r.rows[0]));
}

async function updateEventType(req, res, id) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }

  const db = getDb();

  const check = await db.execute({
    sql: "SELECT id FROM event_types WHERE id = ? AND tenant_id = ?",
    args: [id, tenant.id],
  });
  if (!check.rows[0]) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const body = await readBody(req);

  if ("slug" in body && !isUrlSafeSlug(body.slug)) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "slug must be URL-safe" }));
    return;
  }

  if ("slug" in body) {
    const slugCheck = await db.execute({
      sql: "SELECT id FROM event_types WHERE tenant_id = ? AND slug = ? AND id != ?",
      args: [tenant.id, body.slug, id],
    });
    if (slugCheck.rows[0]) {
      res.statusCode = 409;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "slug already exists" }));
      return;
    }
  }

  if ("target_calendar_id" in body) {
    const calCheck = await db.execute({
      sql: "SELECT id FROM calendars WHERE id = ? AND tenant_id = ?",
      args: [body.target_calendar_id, tenant.id],
    });
    if (!calCheck.rows[0]) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "calendar not found" }));
      return;
    }
  }

  const allowed = [
    "slug",
    "name",
    "duration_min",
    "buffer_min",
    "lead_min",
    "horizon_days",
    "weekdays_mask",
    "work_hours_json",
    "target_calendar_id",
    "location_mode",
    "require_email",
    "pass_required",
    "pass_hash",
    "branding_json",
    "enabled",
  ];

  const updates = [];
  const args = [];
  for (const key of allowed) {
    if (key in body) {
      updates.push(`${key} = ?`);
      args.push(body[key]);
    }
  }

  if (updates.length === 0) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "no fields to update" }));
    return;
  }

  args.push(id);
  await db.execute({
    sql: `UPDATE event_types SET ${updates.join(", ")} WHERE id = ?`,
    args,
  });

  const r = await db.execute({
    sql: "SELECT * FROM event_types WHERE id = ?",
    args: [id],
  });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(r.rows[0]));
}

async function deleteEventType(req, res, id) {
  const { user } = await requireUser(req);
  const tenant = await getTenantForUser(user.id);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant not found" }));
    return;
  }

  const db = getDb();

  const check = await db.execute({
    sql: "SELECT id FROM event_types WHERE id = ? AND tenant_id = ?",
    args: [id, tenant.id],
  });
  if (!check.rows[0]) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  await db.execute({
    sql: "UPDATE event_types SET enabled = 0 WHERE id = ?",
    args: [id],
  });

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}

export default async function handler(req, res) {
  try {
    const id = parsePathId(req);

    if (!id) {
      if (req.method === "GET") {
        await listEventTypes(req, res);
        return;
      }
      if (req.method === "POST") {
        await createEventType(req, res);
        return;
      }
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    if (req.method === "PATCH") {
      await updateEventType(req, res, id);
      return;
    }
    if (req.method === "DELETE") {
      await deleteEventType(req, res, id);
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
