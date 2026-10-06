/** Job Radar tables. Re-exported by schema.ts; apply with `npm run db:push` (or scripts/2026-10-06-job-radar.sql). */

import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './schema';

/** SerpApi responses, keyed by sha256(engine + sorted params minus api_key). Also holds the account.json memo. */
export const serpCache = pgTable(
  'serp_cache',
  {
    key: text('key').primaryKey(),
    engine: text('engine').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  },
  (t) => [index('serp_cache_fetched_idx').on(t.fetchedAt)],
);

export interface RadarEventRow {
  at: string;
  level: 'info' | 'warn' | 'error';
  phase: string;
  message: string;
  source?: string;
}

export const agentRuns = pgTable(
  'agent_run',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** running | awaiting | done | error | cancelled */
    status: text('status').notNull().default('running'),
    phase: text('phase').notNull().default('plan'),
    step: integer('step').notNull().default(0),
    totalSteps: integer('total_steps').notNull().default(0),
    message: text('message').notNull().default(''),
    /** plan, postings, ranked, intel, market, selectedKey */
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
    /** Append-only, capped at 60 by the writer. */
    events: jsonb('events').$type<RadarEventRow[]>().notNull().default([]),
    creditsUsed: integer('credits_used').notNull().default(0),
    /** live | replay */
    mode: text('mode').notNull().default('live'),
    error: text('error').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    /** Step lease: one worker owns the current step until this passes. Null = unclaimed. */
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
  },
  (t) => [
    index('agent_run_user_created_idx').on(t.userId, t.createdAt),
    // At most one active run per user, enforced by the database.
    uniqueIndex('agent_run_one_active_idx')
      .on(t.userId)
      .where(sql`${t.status} in ('running', 'awaiting')`),
  ],
);
