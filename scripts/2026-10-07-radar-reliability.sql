-- Job Radar reliability: poison-step guard and the async-search submission ledger.
--
-- Matches lib/db/schema-radar.ts. Additive and idempotent (IF NOT EXISTS everywhere): safe on
-- a live database, safe to run twice, and safe after scripts/2026-10-06-job-radar.sql (whose
-- current copy already contains this DDL). Apply it BEFORE deploying the code that uses it.
-- Needs nothing else: single-flight reuses serp_cache rows with engine 'inflight'.

-- Incremented inside the claim UPDATE, reset when a step commits. The run fails (with a safe
-- message) when one step has been claimed more than 6 times.
ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- One row per billable upstream search of a run: written (with the credit reservation) BEFORE
-- the http call, search_id filled right after. Primary key = idempotency by (run, query).
-- Rows go with their run (ON DELETE CASCADE, also when pruneRadarData deletes old runs).
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
