-- What the user removed, so no later sync or import proposes it again.
--
-- Additive: one new table, nothing altered. Safe to run on a live database, and safe to
-- run twice.
--
-- `content_hash` is unique per user because the same fact removed twice is one decision,
-- and the second removal should update the mark rather than fail the delete.

CREATE TABLE IF NOT EXISTS dismissed_record (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  -- 'record' or 'role': a job is removed the same way and must not come back either.
  kind          text NOT NULL,
  -- The record type ('skill', 'award', …) or 'role', for what the list shows.
  type          text NOT NULL,
  content_hash  text NOT NULL,
  -- Null where the type has no looser identity; then the fingerprint alone blocks.
  identity_key  text,
  -- What it said, for the Removed list. Kept separate from the snapshot so the list can
  -- be read without unpacking every row.
  label         text NOT NULL DEFAULT '',
  -- Everything needed to put it back, exactly as it was.
  snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where it had come from, so a restored row keeps its provenance honest.
  source        text NOT NULL DEFAULT 'manual',
  created_at    timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dismissed_record_hash_idx
  ON dismissed_record (user_id, content_hash);

CREATE INDEX IF NOT EXISTS dismissed_record_identity_idx
  ON dismissed_record (user_id, identity_key);
