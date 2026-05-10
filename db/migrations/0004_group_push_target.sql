-- Cross-tenant group push (T4.7).
--
-- A receiver can opt in to having a sharer's events pushed onto one of
-- their own calendars (the "Alex puts events on Jordan's Outlook with
-- [Alex] prefix" case). We need somewhere for those events to land —
-- the receiver picks one of their calendars as the target.
--
-- target_calendar_id is nullable; when push_level = 'none' it stays NULL.
-- When push_level != 'none', the engine refuses to push without a target
-- calendar set (validated at run time, not via constraint, so toggling
-- push_level off doesn't cascade-NULL the target).
ALTER TABLE group_receive_settings
  ADD COLUMN target_calendar_id TEXT REFERENCES calendars(id);
CREATE INDEX idx_receive_target ON group_receive_settings(target_calendar_id);
