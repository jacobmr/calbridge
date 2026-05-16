-- Billing / plan entitlements. One subscription per tenant (the tenant
-- owner is the billable party; Family members inherit the owner's plan).
--
-- plan: 'free' | 'individual' | 'family'  (team deferred)
-- status mirrors Lemon Squeezy subscription status so we can gate on
--   active/on_trial vs past_due/cancelled/expired without re-deriving it.
-- ls_* columns are the Lemon Squeezy identifiers needed to reconcile
--   webhooks and open the customer portal. Nullable: a tenant on the
--   free plan has never been to checkout.
--
-- No separate subscriptions table: it's strictly 1:1 with tenant and
-- the lifecycle is fully driven by LS webhooks, so columns on tenants
-- are simpler than a joined row and avoid an extra query on every
-- entitlement check (which happens on hot create paths).

ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE tenants ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN ls_customer_id TEXT;
ALTER TABLE tenants ADD COLUMN ls_subscription_id TEXT;
ALTER TABLE tenants ADD COLUMN ls_variant_id TEXT;
-- Unix ms. When the current paid period ends / renews. We keep serving
-- paid entitlements until this passes even if status flips, so a failed
-- renewal doesn't instantly downgrade mid-period (LS dunning gets a
-- chance to recover the payment).
ALTER TABLE tenants ADD COLUMN plan_renews_at INTEGER;
ALTER TABLE tenants ADD COLUMN plan_updated_at INTEGER;

-- Fast lookup when a webhook arrives keyed by LS subscription id.
CREATE INDEX idx_tenants_ls_sub ON tenants(ls_subscription_id);
