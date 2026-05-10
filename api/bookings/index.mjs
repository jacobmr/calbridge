import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";

function parsePathId(req) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  return segments.length > 2 ? segments[segments.length - 1] : null;
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

async function listBookings(req, res) {
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
    sql: "SELECT * FROM bookings WHERE tenant_id = ? ORDER BY start_ms DESC",
    args: [tenant.id],
  });

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(r.rows));
}

async function getBooking(req, res, id) {
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
    sql: "SELECT * FROM bookings WHERE id = ? AND tenant_id = ?",
    args: [id, tenant.id],
  });

  if (!r.rows[0]) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(r.rows[0]));
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const id = parsePathId(req);
    if (id) {
      await getBooking(req, res, id);
    } else {
      await listBookings(req, res);
    }
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
}
