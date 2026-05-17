/**
 * POST /api/billing/webhook   (Lemon Squeezy → us; reached via the
 * /webhook rewrite in vercel.json since that's the URL configured in
 * the LS dashboard).
 *
 * Security: LS signs every delivery with HMAC-SHA256 of the *raw*
 * request body using LEMONSQUEEZY_WEBHOOK_SECRET, sent as the
 * `X-Signature` header (hex). We must verify against the raw bytes
 * before parsing — never trust an unverified payload.
 *
 * Reconciliation: at checkout we pass checkout[custom][tenant_id] and
 * checkout[custom][plan]; LS echoes them back in meta.custom_data on
 * every subscription event for that subscription. We key the tenant
 * update off tenant_id, falling back to a match on ls_subscription_id
 * for events where custom data might be absent.
 *
 * Idempotency: every handler is a plain UPSERT of derived state, so
 * duplicate deliveries (LS retries on any non-2xx) converge to the
 * same row. We always answer 200 quickly unless the signature fails,
 * so LS doesn't enter a retry storm over an event we intentionally
 * ignore.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "../../db/client.mjs";

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(header), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// LS subscription status → our plan_status. We keep the raw LS string;
// lib/entitlements.effectivePlan() decides what each one grants.
//   active, on_trial            → entitled
//   past_due, unpaid            → entitled within the renews_at grace
//   cancelled                   → entitled until renews_at, then free
//   expired, paused             → free
function mapState(lsStatus) {
  return String(lsStatus || "").toLowerCase() || "active";
}

export default async function handler(req, res) {
  // Answer non-POST cheaply (LS only POSTs; health-checkers may GET).
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "bad body" }));
    return;
  }

  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const sig = req.headers["x-signature"];
  if (!verifySignature(raw, sig, secret)) {
    // 401 — do NOT process. This is the one case we reject loudly.
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid signature" }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "bad json" }));
    return;
  }

  const event = payload?.meta?.event_name || "";
  const custom = payload?.meta?.custom_data || {};
  const attrs = payload?.data?.attributes || {};
  const subscriptionId = payload?.data?.id
    ? String(payload.data.id)
    : null;

  // Only subscription_* events affect entitlements. Everything else
  // (orders, disputes, license keys, affiliate, …) we acknowledge and
  // ignore — returning 200 so LS doesn't retry an event we don't act on.
  if (!event.startsWith("subscription")) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, ignored: event }));
    return;
  }

  try {
    const db = getDb();

    // Resolve the tenant: prefer the custom tenant_id we injected at
    // checkout; fall back to an existing row already linked to this
    // LS subscription id (covers later events if custom data is absent).
    let tenantId = custom.tenant_id || custom.tenantId || null;
    if (!tenantId && subscriptionId) {
      const r = await db.execute({
        sql: "SELECT id FROM tenants WHERE ls_subscription_id = ? LIMIT 1",
        args: [subscriptionId],
      });
      tenantId = r.rows[0]?.id || null;
    }
    if (!tenantId) {
      // Nothing we can map this to. Acknowledge so LS stops retrying;
      // log for investigation (a checkout without our custom data).
      console.error(
        "billing webhook: unmappable subscription event",
        event,
        subscriptionId,
      );
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, unmapped: true }));
      return;
    }

    // plan: trust the custom.plan we set at checkout; if absent on a
    // later event, leave the existing plan untouched (only update
    // status/dates). Guard against an unexpected value.
    const planFromCustom = ["individual", "family"].includes(custom.plan)
      ? custom.plan
      : null;

    const status = mapState(attrs.status);
    // LS sends ISO8601 (or null). renews_at is when the paid period
    // next renews / lapses — the boundary effectivePlan() uses for the
    // cancelled/past-due grace window.
    const renewsAt = attrs.renews_at
      ? Date.parse(attrs.renews_at) || null
      : attrs.ends_at
        ? Date.parse(attrs.ends_at) || null
        : null;
    const customerId = attrs.customer_id
      ? String(attrs.customer_id)
      : null;
    const variantId = attrs.variant_id ? String(attrs.variant_id) : null;
    const now = Date.now();

    // Build the update. We always set status / ls ids / dates; we set
    // plan only when we have an authoritative value (so an out-of-order
    // event can't blank a good plan).
    const sets = [
      "plan_status = ?",
      "ls_subscription_id = ?",
      "ls_customer_id = ?",
      "ls_variant_id = ?",
      "plan_renews_at = ?",
      "plan_updated_at = ?",
    ];
    const args = [
      status,
      subscriptionId,
      customerId,
      variantId,
      renewsAt,
      now,
    ];
    if (planFromCustom) {
      sets.unshift("plan = ?");
      args.unshift(planFromCustom);
    }
    args.push(tenantId);

    await db.execute({
      sql: `UPDATE tenants SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, event, tenant: tenantId }));
  } catch (err) {
    // 500 → LS will retry, which is correct: a transient DB blip
    // should not silently drop a billing state change.
    console.error("billing webhook error:", err.message);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "processing failed" }));
  }
}
