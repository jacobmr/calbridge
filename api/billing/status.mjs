/**
 * GET /api/billing/status
 *
 * Returns the caller tenant's current plan, effective entitlements, and
 * live usage counts so the Billing tab can render "Individual · 3 of ∞
 * sync flows" and decide which upgrade CTAs to show.
 *
 * Read-only; no Lemon Squeezy call — everything is derived from the
 * tenants.plan_* columns that webhooks keep current (Phase B).
 */

import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import {
  effectivePlan,
  planLimits,
  allPlans,
  loadBillingTenant,
} from "../../lib/entitlements.mjs";

async function tenantForUser(db, userId) {
  const owner = await db.execute({
    sql: "SELECT id, owner_user_id FROM tenants WHERE owner_user_id = ? LIMIT 1",
    args: [userId],
  });
  if (owner.rows[0]) return owner.rows[0];
  const member = await db.execute({
    sql: `SELECT t.id, t.owner_user_id
            FROM oauth_accounts oa JOIN tenants t ON t.id = oa.tenant_id
           WHERE oa.user_id = ? LIMIT 1`,
    args: [userId],
  });
  return member.rows[0] || null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const { user } = await requireUser(req);
    const db = getDb();
    const t = await tenantForUser(db, user.id);
    if (!t) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "tenant not found" }));
      return;
    }

    const tenant = await loadBillingTenant(t.id);
    const plan = effectivePlan(tenant);
    const limits = planLimits(tenant);

    // Live usage. Cheap COUNTs; this endpoint is hit only when the
    // Billing tab opens, not on a hot path.
    const [cals, flows, ets, polls, groups] = await Promise.all([
      db.execute({
        sql: "SELECT COUNT(*) AS n FROM calendars WHERE tenant_id = ?",
        args: [t.id],
      }),
      db.execute({
        sql: "SELECT COUNT(*) AS n FROM sync_flows WHERE tenant_id = ?",
        args: [t.id],
      }),
      db.execute({
        sql: "SELECT COUNT(*) AS n FROM event_types WHERE tenant_id = ?",
        args: [t.id],
      }),
      db.execute({
        sql: "SELECT COUNT(*) AS n FROM polls WHERE tenant_id = ?",
        args: [t.id],
      }),
      db.execute({
        sql: "SELECT COUNT(*) AS n FROM groups WHERE created_by_user_id = ?",
        args: [t.owner_user_id],
      }),
    ]);

    const num = (r) => Number(r.rows[0].n);
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "private, no-store");
    res.end(
      JSON.stringify({
        plan,
        plan_status: tenant.plan_status || "active",
        plan_renews_at: tenant.plan_renews_at
          ? Number(tenant.plan_renews_at)
          : null,
        limits: {
          calendars: numericOrNull(limits.calendars),
          syncFlows: numericOrNull(limits.syncFlows),
          eventTypes: numericOrNull(limits.eventTypes),
          polls: numericOrNull(limits.polls),
          groups: numericOrNull(limits.groups),
          groupMembers: numericOrNull(limits.groupMembers),
        },
        usage: {
          calendars: num(cals),
          syncFlows: num(flows),
          eventTypes: num(ets),
          polls: num(polls),
          groups: num(groups),
        },
        plans: allPlans(),
        // Phase B fills checkout_urls keyed by target plan; until then
        // the UI shows "upgrade" CTAs that are inert/"coming soon".
        checkout_urls: {},
      }),
    );
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message || "server error" }));
  }
}

// Infinity isn't JSON-serializable (becomes null) — make the "unlimited"
// contract explicit so the client doesn't guess.
function numericOrNull(v) {
  return v === Infinity ? null : v;
}
