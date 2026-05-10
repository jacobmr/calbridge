-- Email-keyed group invitations.
--
-- group_memberships requires a real user_id, which made it impossible to
-- invite someone before they signed up — exactly the case we ran into in
-- production ("can you add my partner?" "she doesn't have MiCal yet"
-- "...exactly the point of inviting her"). This table holds invitations
-- by email address, with a token that doubles as the unguessable signup
-- link. On signup, we look up any pending invites for the new user's
-- email and convert them into active memberships.
--
-- group_id + email are unique so re-inviting the same email refreshes
-- (rather than creating duplicate rows).

CREATE TABLE group_invites (
  id                 TEXT PRIMARY KEY,
  group_id           TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'member'
                       CHECK(role IN ('admin', 'member')),
  token              TEXT NOT NULL UNIQUE,
  invited_by_user_id TEXT REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  UNIQUE(group_id, email)
);
CREATE INDEX idx_group_invites_email ON group_invites(email);
