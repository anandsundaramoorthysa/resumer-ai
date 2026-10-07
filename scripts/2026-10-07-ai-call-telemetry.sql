-- Per-attempt AI telemetry (lib/db/schema-ai.ts). Idempotent; safe to re-run.
CREATE TABLE IF NOT EXISTS "ai_call" (
  "id" text PRIMARY KEY NOT NULL,
  "draft_run_id" text,
  "user_id" text,
  "stage" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "path" text NOT NULL,
  "prompt_version" text,
  "in_tokens" integer DEFAULT 0 NOT NULL,
  "out_tokens" integer DEFAULT 0 NOT NULL,
  "latency_ms" integer DEFAULT 0 NOT NULL,
  "error_class" text,
  "finish_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_call_created_idx" ON "ai_call" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "ai_call_provider_created_idx" ON "ai_call" USING btree ("provider","created_at");
