-- Draft idempotency (2026-10-08). Additive and idempotent: safe to run more than once.
-- Mirrors draftRuns.idempotencyKey / draft_run_idem_uq in lib/db/schema.ts.
ALTER TABLE draft_run ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS draft_run_idem_uq
  ON draft_run (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
