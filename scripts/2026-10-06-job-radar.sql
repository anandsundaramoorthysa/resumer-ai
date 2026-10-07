-- Job Radar: the run table and the SerpApi response cache.
--
-- Matches lib/db/schema-radar.ts. Additive: two new tables, nothing altered. Safe to run
-- on a live database, and safe to run twice. `npm run db:push` does the same thing.
--
-- agent_run: one row per radar run. `leased_until` is the step lease (one worker owns the
-- current step until it passes). The partial unique index allows one active run per user.
-- serp_cache: provider responses, plus the account.json memo. `fetched_at` is indexed so
-- old rows can be evicted cheaply.

CREATE TABLE IF NOT EXISTS serp_cache (
  key         text PRIMARY KEY,
  engine      text NOT NULL,
  payload     jsonb NOT NULL,
  fetched_at  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS serp_cache_fetched_idx
  ON serp_cache (fetched_at);

CREATE TABLE IF NOT EXISTS agent_run (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  -- running | awaiting | done | error | cancelled
  status        text NOT NULL DEFAULT 'running',
  phase         text NOT NULL DEFAULT 'plan',
  step          integer NOT NULL DEFAULT 0,
  total_steps   integer NOT NULL DEFAULT 0,
  message       text NOT NULL DEFAULT '',
  state         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Append-only, capped at 60 by the writer.
  events        jsonb NOT NULL DEFAULT '[]'::jsonb,
  credits_used  integer NOT NULL DEFAULT 0,
  -- live | replay
  mode          text NOT NULL DEFAULT 'live',
  error         text NOT NULL DEFAULT '',
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now(),
  leased_until  timestamptz,
  -- times the current step was claimed; reset on commit (poison-step guard)
  attempts      integer NOT NULL DEFAULT 0
);

-- A table created by an earlier version of this script or db:push may lack these.
ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS leased_until timestamptz;
ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Submission ledger (see scripts/2026-10-07-radar-reliability.sql, which is the same DDL for
-- databases that already applied an older copy of this file).
CREATE TABLE IF NOT EXISTS radar_search (
  run_id        text NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  key           text NOT NULL,
  engine        text NOT NULL,
  q             text NOT NULL DEFAULT '',
  search_id     text NOT NULL DEFAULT '',
  credits       integer NOT NULL DEFAULT 0,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT radar_search_run_id_key_pk PRIMARY KEY (run_id, key)
);

CREATE INDEX IF NOT EXISTS agent_run_user_created_idx
  ON agent_run (user_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS agent_run_one_active_idx
  ON agent_run (user_id)
  WHERE status IN ('running', 'awaiting');
