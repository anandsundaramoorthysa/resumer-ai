/**
 * Retention for the Job Radar tables. Idempotent and safe to run at any time, as often as
 * wanted (a scheduled function calls pruneRadarData once or twice a day):
 *
 *  - serp_cache rows older than 24h (every engine except the 'account' memo, which is rewritten
 *    in place and is tiny). This also drops stale 'attempt' and 'inflight' bookkeeping rows.
 *  - agent_run rows in a terminal status (done / error / cancelled) older than 30 days; their
 *    radar_search ledger rows go with them (ON DELETE CASCADE).
 *
 * Deletes run in small batches (a bounded number per call) so no single statement holds locks
 * for long; a call that hit the bound reports `more: true` and the next run continues.
 */

import { sql } from 'drizzle-orm';

export interface PruneResult {
  cacheRows: number;
  runs: number;
  /** A batch limit was hit: there may be more to delete, call again. */
  more: boolean;
}

export const CACHE_MAX_AGE_HOURS = 24;
export const RUN_MAX_AGE_DAYS = 30;

type Db = typeof import('@/lib/db').db;

const count = (r: unknown): number => {
  const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] } | null)?.rows ?? []);
  return Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
};

export async function pruneRadarData(
  dbOverride?: Db,
  opts: { batch?: number; maxBatches?: number; deadline?: number } = {},
): Promise<PruneResult> {
  const db = dbOverride ?? (await import('@/lib/db')).db;
  const batch = Math.max(1, Math.floor(opts.batch ?? 500));
  const maxBatches = Math.max(1, Math.floor(opts.maxBatches ?? 20));
  // Checked BEFORE every batch (a batch itself is short): a caller's time budget is honoured to within one batch.
  const deadline = opts.deadline ?? Date.now() + 8_000;
  const out: PruneResult = { cacheRows: 0, runs: 0, more: false };

  // timestamps are compared in UTC: serp_cache.fetched_at is a plain timestamp written from JS (UTC).
  const cacheCutoff = new Date(Date.now() - CACHE_MAX_AGE_HOURS * 3_600_000).toISOString();
  for (let i = 0; i < maxBatches; i++) {
    if (Date.now() >= deadline) {
      out.more = true;
      break;
    }
    const n = count(
      await db.execute(sql`
        with gone as (
          delete from serp_cache where key in (
            select key from serp_cache
            where fetched_at < ${cacheCutoff}::timestamp and engine <> 'account'
            limit ${batch}
          ) returning 1
        ) select count(*)::int as n from gone`),
    );
    out.cacheRows += n;
    if (n < batch) break;
    if (i === maxBatches - 1) out.more = true;
  }

  const runCutoff = new Date(Date.now() - RUN_MAX_AGE_DAYS * 86_400_000).toISOString();
  for (let i = 0; i < maxBatches; i++) {
    if (Date.now() >= deadline) {
      out.more = true;
      break;
    }
    const n = count(
      await db.execute(sql`
        with gone as (
          delete from agent_run where id in (
            select id from agent_run
            where status in ('done', 'error', 'cancelled') and updated_at < ${runCutoff}::timestamp
            limit ${batch}
          ) returning 1
        ) select count(*)::int as n from gone`),
    );
    out.runs += n;
    if (n < batch) break;
    if (i === maxBatches - 1) out.more = true;
  }
  return out;
}
