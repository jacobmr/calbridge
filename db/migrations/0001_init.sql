CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  default_tz TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  brand_json TEXT,
  notify_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_tenants_owner ON tenants(owner_user_id);

CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  refresh_token_enc BLOB NOT NULL,
  access_token_enc BLOB,
  access_token_expires_at INTEGER,
  scopes TEXT NOT NULL,
  raw_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, provider, provider_account_id)
);

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  oauth_account_id TEXT REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_calendar_id TEXT,
  ics_url_enc BLOB,
  label TEXT NOT NULL,
  role TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(tenant_id, provider, provider_calendar_id)
);
CREATE INDEX idx_cals_tenant ON calendars(tenant_id);

CREATE TABLE sync_flows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_calendar_id TEXT NOT NULL REFERENCES calendars(id),
  target_calendar_id TEXT NOT NULL REFERENCES calendars(id),
  options_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  ord INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_flows_tenant ON sync_flows(tenant_id, ord);

CREATE TABLE event_types (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  buffer_min INTEGER NOT NULL DEFAULT 0,
  lead_min INTEGER NOT NULL DEFAULT 0,
  horizon_days INTEGER NOT NULL DEFAULT 25,
  weekdays_mask INTEGER NOT NULL DEFAULT 31,
  work_hours_json TEXT NOT NULL,
  target_calendar_id TEXT NOT NULL REFERENCES calendars(id),
  location_mode TEXT NOT NULL DEFAULT 'meet',
  require_email INTEGER NOT NULL DEFAULT 1,
  pass_required INTEGER NOT NULL DEFAULT 0,
  pass_hash TEXT,
  branding_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(tenant_id, slug)
);
CREATE INDEX idx_evtypes_tenant ON event_types(tenant_id);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_type_id TEXT NOT NULL REFERENCES event_types(id),
  cancel_token TEXT NOT NULL UNIQUE,
  provider_event_id TEXT,
  attendee_email TEXT,
  attendee_name TEXT,
  subject TEXT,
  notes TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER
);
CREATE INDEX idx_bookings_tenant_start ON bookings(tenant_id, start_ms);
CREATE INDEX idx_bookings_evtype_start ON bookings(event_type_id, start_ms);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  totals_json TEXT,
  errors_json TEXT
);
CREATE INDEX idx_runs_tenant ON sync_runs(tenant_id, started_at DESC);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE kv_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  actor_user_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX idx_audit_tenant_at ON audit_log(tenant_id, at DESC);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  provider TEXT NOT NULL,
  tenant_id TEXT,
  return_to TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
