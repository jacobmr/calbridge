/**
 * Plan entitlements — the single source of truth for what each plan can
 * do. Used by the soft gates on create paths and by the billing UI to
 * show limits/usage.
 *
 * Soft-gate philosophy (decided with the founder): never disable or
 * delete a user's existing configuration when they're over a limit.
 * Only block *creating new* things beyond the limit, with an upgrade
 * prompt. So the limit is checked at create-time as "current count >=
 * limit → blocked", and an existing over-limit state (e.g. from a
 * downgrade) just means they can't add more until they're back under.
 *
 * Plans: free | individual | family. Team is deferred — if a 'team'
 * plan string ever appears it falls through to individual limits
 * (safe: unlimited personal scope) until Team is implemented.
 */

const UNLIMITED = Infinity;

// Per-plan caps. null/Infinity = unlimited. `groups` is the number of
// groups the tenant owner may create; `groupMembers` is the per-group
// active-member cap (the Family differentiator).
const PLANS = {
  free: {
    label: "Free",
    calendars: 1,
    syncFlows: 1,
    eventTypes: 1,
    polls: 1,
    groups: 0,
    groupMembers: 0,
    brandingFooter: true, // "Sent with MiCal" footer on booking pages
  },
  individual: {
    label: "Individual",
    calendars: UNLIMITED,
    syncFlows: UNLIMITED,
    eventTypes: UNLIMITED,
    polls: UNLIMITED,
    groups: 0,
    groupMembers: 0,
    brandingFooter: false,
  },
  family: {
    label: "Family",
    calendars: UNLIMITED,
    syncFlows: UNLIMITED,
    eventTypes: UNLIMITED,
    polls: UNLIMITED,
    groups: UNLIMITED,
    groupMembers: 5, // up to 5 active members in one family group
    brandingFooter: false,
  },
};

// A subscription only confers its paid entitlements while it's in a
// "good" state. We treat past_due/unpaid as still-entitled until
// plan_renews_at passes (LS dunning window) so a transient failed
// charge doesn't instantly downgrade someone mid-month.
const ENTITLED_STATUSES = new Set([
  "active",
  "on_trial",
  "past_due",
  "unpaid",
  "cancelled", // cancelled-but-not-yet-expired: still paid through period
]);

/**
 * Resolve a tenant row to its effective plan key, accounting for status
 * and the dunning grace window. Returns 'free' | 'individual' | 'family'.
 */
export function effectivePlan(tenant) {
  const plan = String(tenant?.plan || "free");
  if (plan === "free" || !PLANS[plan]) {
    return PLANS[plan] ? plan : "free";
  }
  const status = String(tenant?.plan_status || "active");
  if (ENTITLED_STATUSES.has(status)) {
    // 'cancelled' / 'past_due' keep paid entitlements only until the
    // period actually ends.
    if (
      (status === "cancelled" ||
        status === "past_due" ||
        status === "unpaid") &&
      tenant?.plan_renews_at &&
      Date.now() > Number(tenant.plan_renews_at)
    ) {
      return "free";
    }
    return plan;
  }
  // expired / paused / anything unknown → no paid entitlement
  return "free";
}

export function planLimits(tenant) {
  return PLANS[effectivePlan(tenant)] || PLANS.free;
}

/**
 * Soft-gate check. feature is one of: calendars | syncFlows | eventTypes
 * | polls | groups. currentCount is how many the tenant already has.
 *
 * Returns { allowed: boolean, limit, plan, reason? }. allowed=false
 * means the create should be blocked and the caller should surface an
 * upgrade prompt (reason is human copy for that prompt).
 */
export function canCreate(tenant, feature, currentCount) {
  const limits = planLimits(tenant);
  const limit = limits[feature];
  if (limit === undefined) {
    // Unknown feature key — fail open rather than block legitimate use.
    return { allowed: true, limit: UNLIMITED, plan: effectivePlan(tenant) };
  }
  if (limit === UNLIMITED) {
    return { allowed: true, limit: UNLIMITED, plan: effectivePlan(tenant) };
  }
  if (currentCount < limit) {
    return { allowed: true, limit, plan: effectivePlan(tenant) };
  }
  const planKey = effectivePlan(tenant);
  const noun = {
    calendars: "connected calendar",
    syncFlows: "sync flow",
    eventTypes: "booking page",
    polls: "poll",
    groups: "group",
  }[feature] || feature;
  // Reference the PLANS labels rather than hardcoding strings, so this
  // stays correct if a plan is renamed or Team lands later.
  const upgradeTo =
    feature === "groups" ? PLANS.family.label : PLANS.individual.label;
  return {
    allowed: false,
    limit,
    plan: planKey,
    reason:
      limit === 0
        ? `Groups are a ${upgradeTo} feature. Upgrade to create one.`
        : `The ${PLANS[planKey].label} plan includes ${limit} ${noun}${
            limit === 1 ? "" : "s"
          }. Upgrade to ${upgradeTo} for unlimited.`,
  };
}

export function allPlans() {
  return PLANS;
}

import { getDb } from "../db/client.mjs";

// Count of existing items for a feature, scoped to the tenant. Groups
// are counted by creator (they aren't tenant-scoped in the schema).
async function currentCountFor(db, tenant, feature) {
  const tid = tenant.id;
  switch (feature) {
    case "calendars": {
      const r = await db.execute({
        sql: "SELECT COUNT(*) AS n FROM calendars WHERE tenant_id = ?",
        args: [tid],
      });
      return Number(r.rows[0].n);
    }
    case "syncFlows": {
      const r = await db.execute({
        sql: "SELECT COUNT(*) AS n FROM sync_flows WHERE tenant_id = ?",
        args: [tid],
      });
      return Number(r.rows[0].n);
    }
    case "eventTypes": {
      const r = await db.execute({
        sql: "SELECT COUNT(*) AS n FROM event_types WHERE tenant_id = ?",
        args: [tid],
      });
      return Number(r.rows[0].n);
    }
    case "polls": {
      const r = await db.execute({
        sql: "SELECT COUNT(*) AS n FROM polls WHERE tenant_id = ?",
        args: [tid],
      });
      return Number(r.rows[0].n);
    }
    case "groups": {
      const r = await db.execute({
        sql: "SELECT COUNT(*) AS n FROM groups WHERE created_by_user_id = ?",
        args: [tenant.owner_user_id],
      });
      return Number(r.rows[0].n);
    }
    default:
      return 0;
  }
}

/**
 * Load the tenant's billing-relevant columns by tenant id. Returns null
 * if the tenant doesn't exist. Cheap single-row read; the create paths
 * already resolved a tenant id so this is one extra indexed lookup.
 */
export async function loadBillingTenant(tenantId) {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT id, owner_user_id, plan, plan_status, plan_renews_at
            FROM tenants WHERE id = ? LIMIT 1`,
    args: [tenantId],
  });
  return r.rows[0] || null;
}

/**
 * One-call soft gate for create endpoints. Loads billing state, counts
 * existing items, runs canCreate. Returns the canCreate shape plus a
 * convenience `status` (402 = needs upgrade) so callers can:
 *
 *   const gate = await enforceLimit(tenant.id, "syncFlows");
 *   if (!gate.allowed) { res.statusCode = gate.status;
 *     return res.end(JSON.stringify({ error: gate.reason,
 *       upgrade: true, plan: gate.plan })); }
 *
 * Fails OPEN on a missing tenant or count error — billing must never
 * be the reason a paying flow breaks.
 */
export async function enforceLimit(tenantId, feature, adding = 1) {
  try {
    const db = getDb();
    const tenant = await loadBillingTenant(tenantId);
    if (!tenant) return { allowed: true, failedOpen: true };
    const count = await currentCountFor(db, tenant, feature);
    // Batch-aware: a path that adds `adding` items at once (e.g. the
    // calendar-import modal selecting several at a time) must check the
    // whole batch fits, not just "is there room for one more". We model
    // it as: would the LAST item of the batch exceed the cap?
    const result = canCreate(tenant, feature, count + (adding - 1));
    return { ...result, status: result.allowed ? 200 : 402 };
  } catch {
    return { allowed: true, failedOpen: true };
  }
}
