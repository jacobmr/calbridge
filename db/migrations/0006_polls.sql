-- Meeting polls (Doodle / Calendly-Poll competitor with calendar pre-check).
--
-- A poll is owned by a tenant and authored by an organizer (a user). The
-- organizer proposes N candidate options; respondents pick which work; the
-- organizer picks the winner and we create a real calendar event with all
-- responders as attendees. The differentiator over existing tools is that
-- a respondent who's signed in via MiCal sees each option pre-marked
-- free/busy from their actual connected calendars — no manual checking.

CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  organizer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  duration_min INTEGER NOT NULL DEFAULT 30,
  location_text TEXT,
  -- Public URL token. Opaque, unguessable, 24 random bytes base64url-encoded.
  -- Same shape as group_invites.token.
  token TEXT NOT NULL UNIQUE,
  -- State machine: open -> (closed | scheduled | cancelled)
  status TEXT NOT NULL DEFAULT 'open',
  -- Set when status='scheduled'
  selected_option_id TEXT,
  scheduled_calendar_id TEXT,
  scheduled_event_id TEXT,
  -- 1 forces respondents to provide email so we can notify them of the winner;
  -- 0 lets the organizer accept anonymous votes (for low-stakes polls).
  require_email INTEGER NOT NULL DEFAULT 1,
  closes_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_polls_tenant ON polls(tenant_id);
CREATE INDEX idx_polls_token ON polls(token);

CREATE TABLE poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_poll_options_poll ON poll_options(poll_id, start_ms);

CREATE TABLE poll_responses (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  -- Identity of responder. signed-in MiCal users get user_id; anonymous-with-
  -- email votes get just an email; fully anonymous (rare; only when organizer
  -- disabled require_email) get neither.
  responder_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  responder_email TEXT,
  responder_name TEXT,
  -- JSON array of poll_options.id values the responder marked OK.
  picked_option_ids_json TEXT NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_poll_responses_poll ON poll_responses(poll_id);
-- Partial unique indexes: at most one response per (poll, identifier). The
-- WHERE clauses let multiple "fully anonymous" votes coexist with each other
-- but block double-voting once an identifier is present.
CREATE UNIQUE INDEX idx_poll_responses_user
  ON poll_responses(poll_id, responder_user_id)
  WHERE responder_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_poll_responses_email
  ON poll_responses(poll_id, responder_email)
  WHERE responder_email IS NOT NULL;
