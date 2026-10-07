/**
 * Versioned-migration helpers, kept free of any database import so tests can use them.
 *
 * The app has always changed its schema with `drizzle-kit push` plus hand-run SQL in
 * scripts/. That leaves no history and no rollback point. From the 0000_baseline migration on,
 * schema changes go through `npm run db:generate` (writes drizzle/NNNN_*.sql) and are applied by
 * `npm run db:migrate` (scripts/migrate.mts), which records each applied file in
 * "drizzle"."__drizzle_migrations".
 *
 * A database that was built by push + scripts/*.sql already contains everything in the baseline,
 * so it must be MARKED as at baseline, not have the baseline run against it (`db:baseline`).
 * Marking inserts the same row drizzle-orm's migrator would have inserted: the SHA-256 of the
 * migration file and the journal's `when` timestamp (the migrator applies a file only when its
 * `when` is newer than the newest recorded row).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export interface BaselineRow {
  tag: string;
  hash: string;
  createdAt: number;
}

export const MIGRATIONS_FOLDER = 'drizzle';

/** The hash drizzle-orm's readMigrationFiles computes: SHA-256 of the file text. */
export function migrationHash(sqlText: string): string {
  return createHash('sha256').update(sqlText).digest('hex');
}

export function readJournal(folder: string = MIGRATIONS_FOLDER): JournalEntry[] {
  const path = join(folder, 'meta', '_journal.json');
  if (!existsSync(path)) throw new Error(`No migration journal at ${path}. Run npm run db:generate first.`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: JournalEntry[] };
  return parsed.entries ?? [];
}

/**
 * The rows that mark a database as already containing migrations up to and including `through`
 * (default: only the first, i.e. the baseline). Marking later migrations by accident would hide
 * them from the migrator forever, so anything beyond `through` is left out.
 */
export function baselineRows(folder: string = MIGRATIONS_FOLDER, through?: string): BaselineRow[] {
  const entries = readJournal(folder);
  if (entries.length === 0) throw new Error('The migration journal is empty.');
  const last = through ?? entries[0].tag;
  const stop = entries.findIndex((e) => e.tag === last);
  if (stop < 0) throw new Error(`No migration named "${last}" in the journal.`);
  return entries.slice(0, stop + 1).map((e) => ({
    tag: e.tag,
    hash: migrationHash(readFileSync(join(folder, `${e.tag}.sql`), 'utf8')),
    createdAt: e.when,
  }));
}

/** Journal entries newer than the newest applied migration: what `db:migrate` would run. */
export function pendingMigrations(entries: JournalEntry[], newestAppliedMillis: number | null): JournalEntry[] {
  if (newestAppliedMillis === null) return entries;
  return entries.filter((e) => e.when > newestAppliedMillis);
}
