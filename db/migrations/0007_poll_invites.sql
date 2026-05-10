-- Poll invites — an explicit list of email addresses the organizer wants to
-- notify about a poll. Distinct from poll_responses (an invite is just "this
-- person was asked"; a response is "they answered").
--
-- We send the invite email via Resend immediately on poll create. The
-- email_sent_at column is populated on success; email_failed_reason captures
-- a short string when Resend returned a non-2xx so the organizer can see
-- which addresses didn't go through.

CREATE TABLE poll_invites (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  invited_at INTEGER NOT NULL,
  email_sent_at INTEGER,
  email_failed_reason TEXT,
  UNIQUE(poll_id, email)
);
CREATE INDEX idx_poll_invites_poll ON poll_invites(poll_id);
