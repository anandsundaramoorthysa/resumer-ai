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
  leased_until  timestamptz
);

-- A table created by an earlier version of this script or db:push may lack the lease.
ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS leased_until timestamptz;

CREATE INDEX IF NOT EXISTS agent_run_user_created_idx
  ON agent_run (user_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS agent_run_one_active_idx
  ON agent_run (user_id)
  WHERE status IN ('running', 'awaiting');
