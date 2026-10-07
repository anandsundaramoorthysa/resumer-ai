/**
 * One row per model attempt (success or failure) — lib/ai/telemetry.ts.
 *
 * No prompt or output text is stored, only sizes and outcomes. `user_id` is a plain text
 * column with no foreign key on purpose: telemetry must never block or cascade a user
 * deletion, and an orphaned id says nothing without the user row. Re-exported by schema.ts;
 * apply with scripts/2026-10-07-ai-call-telemetry.sql. Prune with `pruneAiCalls`.
 */

import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const aiCall = pgTable(
  'ai_call',
  {
    id: text('id').primaryKey(),
    draftRunId: text('draft_run_id'),
    userId: text('user_id'),
    stage: text('stage').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** 'structured' | 'json' | 'text' */
    path: text('path').notNull(),
    promptVersion: text('prompt_version'),
    inTokens: integer('in_tokens').notNull().default(0),
    outTokens: integer('out_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    errorClass: text('error_class'),
    finishReason: text('finish_reason'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('ai_call_created_idx').on(t.createdAt),
    index('ai_call_provider_created_idx').on(t.provider, t.createdAt),
  ],
);
