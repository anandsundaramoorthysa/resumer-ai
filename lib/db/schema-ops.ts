/** Operations tables. Re-exported by schema.ts; SQL in scripts/2026-10-07-ops-indexes-flags.sql. */

import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Owner-controlled switches (kill switches, maintenance banner). Read through
 * lib/server/flags.ts, which caches for 15s and fails open to the default.
 */
export const appSetting = pgTable('app_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  /** The owner's user id, or null when set from SQL. */
  updatedBy: text('updated_by'),
});
