/** Job Radar tables. Re-exported by schema.ts; apply with `npm run db:push` (or scripts/2026-10-06-job-radar.sql). */

import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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
    // KNOWN LIMIT: created_at/updated_at are `timestamp` WITHOUT time zone, compared with UTC values written
    // from JS (stale-run and retention cutoffs): correct only while the DB session zone is UTC (true on Neon).
    // See docs/production/OPERATIONS.md section 9.
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    /** Step lease: one worker owns the current step until this passes. Null = unclaimed. */
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    /** Times the CURRENT step was claimed (incremented in claim(), reset on commit). A poison step is failed past a cap. */
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    index('agent_run_user_created_idx').on(t.userId, t.createdAt),
    // At most one active run per user, enforced by the database.
    uniqueIndex('agent_run_one_active_idx')
      .on(t.userId)
      .where(sql`${t.status} in ('running', 'awaiting')`),
  ],
);

/**
 * Submission ledger: one row per billable upstream search of a run (key 'q0'..'q2' for
 * searches, 'i0'.. for employer intel). It makes submitting idempotent by (run_id, key):
 * the row (and the credit reservation on agent_run.credits_used) is written BEFORE the http
 * call, with search_id '' ; the search id is filled in right after. A step that is killed and
 * reclaimed finds the row and never submits that query again.
 */
export const radarSearches = pgTable(
  'radar_search',
  {
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    engine: text('engine').notNull(),
    q: text('q').notNull().default(''),
    /** '' = reserved, submit in flight or lost; otherwise SerpApi's search_metadata.id. */
    searchId: text('search_id').notNull().default(''),
    credits: integer('credits').notNull().default(0),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.key] })],
);
