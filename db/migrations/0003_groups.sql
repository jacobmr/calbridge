-- Phase 4: Groups (families & teams).
--
-- A "group" is a shared calendar context. type='family' or type='team' —
-- same feature, different defaults and copy in the UI. A user can be in
-- multiple groups (their family + several work teams).
--
-- Sharing model: each member chooses what they SHARE (group_calendar_shares),
-- and each member chooses how they RECEIVE other members' events
-- (group_receive_settings). The sharer controls exposure of their data;
-- the receiver controls how that data lands in their world.

CREATE TABLE groups (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL UNIQUE,
  type               TEXT NOT NULL CHECK(type IN ('family', 'team')),
  description        TEXT,
  avatar_url         TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_groups_creator ON groups(created_by_user_id);

CREATE TABLE group_memberships (
  id                  TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'member'
                        CHECK(role IN ('owner', 'admin', 'member')),
  -- 'pending' = invited but not yet accepted; rows are removed (or status
  -- flipped to 'removed') when a user is kicked.
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('pending', 'active', 'removed')),
  invited_by_user_id  TEXT REFERENCES users(id),
  joined_at           INTEGER,
  created_at          INTEGER NOT NULL,
  UNIQUE(group_id, user_id)
);
CREATE INDEX idx_memberships_user   ON group_memberships(user_id);
CREATE INDEX idx_memberships_group  ON group_memberships(group_id);

-- "What I share with this group" — sharer-side config.
-- One row per (group, user, calendar). share_level defaults to 'full' so
-- adding a calendar to a family is a one-click action.
CREATE TABLE group_calendar_shares (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_id  TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  share_level  TEXT NOT NULL DEFAULT 'full'
                 CHECK(share_level IN ('full', 'free_busy', 'none')),
  created_at   INTEGER NOT NULL,
  UNIQUE(group_id, user_id, calendar_id)
);
CREATE INDEX idx_shares_group_user ON group_calendar_shares(group_id, user_id);

-- "How I receive events from each other group member" — receiver-side config.
-- One row per (group, receiver, sharer). receive_level controls visibility in
-- the merged view; push_level controls whether the sharer's events also get
-- written into the receiver's own calendars (the "Alex puts dinner on
-- Jordan's Outlook with [Alex] prefix" case). acceptance_mode lets the
-- receiver gate that push behind an explicit accept.
CREATE TABLE group_receive_settings (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  receiver_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sharer_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receive_level     TEXT NOT NULL DEFAULT 'full'
                      CHECK(receive_level IN ('full', 'free_busy', 'none')),
  push_level        TEXT NOT NULL DEFAULT 'none'
                      CHECK(push_level IN ('full', 'busy_only', 'none')),
  event_prefix      TEXT,
  acceptance_mode   TEXT NOT NULL DEFAULT 'auto'
                      CHECK(acceptance_mode IN ('auto', 'invite', 'block')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(group_id, receiver_user_id, sharer_user_id)
);
CREATE INDEX idx_receive_receiver ON group_receive_settings(receiver_user_id, group_id);

-- Existing tables get a nullable group_id for group-scoped resources.
-- Sync flows can be cross-tenant within a group (Phase 4 cross-tenant push).
-- Event types and bookings can be group-scoped ("book time with our family").
ALTER TABLE sync_flows  ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE event_types ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE bookings    ADD COLUMN group_id TEXT REFERENCES groups(id);
CREATE INDEX idx_flows_group       ON sync_flows(group_id);
CREATE INDEX idx_evtypes_group     ON event_types(group_id);
CREATE INDEX idx_bookings_group    ON bookings(group_id);

-- Drives the "X new bookings since you last looked" badge.
ALTER TABLE users ADD COLUMN last_viewed_bookings_at INTEGER;
