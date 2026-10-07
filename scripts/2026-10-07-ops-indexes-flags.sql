-- Ops: performance indexes + kill-switch table (lib/db/schema.ts, lib/db/schema-ops.ts).
-- Idempotent; safe to re-run. On a big live table prefer running each CREATE INDEX with
-- CONCURRENTLY from psql (it cannot run inside a transaction); sizes here are small.

-- Daily usage sum becomes an index-only scan (measured 155ms seq scan -> 3.3ms).
CREATE INDEX IF NOT EXISTS "ai_usage_daily_day_idx" ON "ai_usage_daily" USING btree ("day","calls","tokens");

-- Foreign keys that had no index (measured 11ms -> 0.2ms per delete check).
CREATE INDEX IF NOT EXISTS "application_snapshot_idx" ON "application" USING btree ("resume_snapshot_id");
CREATE INDEX IF NOT EXISTS "draft_run_snapshot_idx" ON "draft_run" USING btree ("snapshot_id");

-- Retention sweep by age.
CREATE INDEX IF NOT EXISTS "draft_run_started_idx" ON "draft_run" USING btree ("started_at");

CREATE TABLE IF NOT EXISTS "app_setting" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text DEFAULT '' NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "updated_by" text
);
