/** Job Radar tables. Re-exported by schema.ts; apply with `npm run db:push`. */

import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './schema';

/** SerpApi responses, keyed by sha256(engine + sorted params minus api_key). Also holds the account.json memo. */
export const serpCache = pgTable('serp_cache', {
  key: text('key').primaryKey(),
  engine: text('engine').notNull(),
  payload: jsonb('payload').$type<unknown>().notNull(),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
});

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
  },
  (t) => [index('agent_run_user_created_idx').on(t.userId, t.createdAt)],
);
