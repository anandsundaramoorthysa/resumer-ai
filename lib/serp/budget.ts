/**
 * Credit guard + cache storage for SerpApi (free tier: 250/month, 50/hour).
 *
 * Storage is behind a tiny `CacheStore` so tests run offline with the in-memory one; the
 * default is Drizzle on `serp_cache`, loaded lazily so importing this file never touches a
 * database.
 */

import { createHash } from 'node:crypto';
import type { SerpMode } from './types';

export interface CacheStore {
  get(key: string): Promise<{ payload: unknown; fetchedAt: Date } | null>;
  put(key: string, engine: string, payload: unknown): Promise<void>;
  /** Search attempts (rows with engine 'attempt') since `since`: successes, failures and timeouts alike. */
  countSince(since: Date): Promise<number>;
}

type Row = { engine: string; payload: unknown; fetchedAt: Date };

export function memoryStore(): CacheStore & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  return {
    rows,
    async get(key) {
      const r = rows.get(key);
      return r ? { payload: r.payload, fetchedAt: r.fetchedAt } : null;
    },
    async put(key, engine, payload) {
      rows.set(key, { engine, payload, fetchedAt: new Date() });
    },
    async countSince(since) {
      return [...rows.values()].filter((r) => r.engine === 'attempt' && r.fetchedAt >= since).length;
    },
  };
}

// dbOverride is a test seam (scripts/verify-radar-db.mts); production passes nothing.
export function drizzleStore(dbOverride?: typeof import('@/lib/db').db): CacheStore {
  const load = async () => {
    const [{ db: realDb }, { serpCache }, orm] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/db/schema-radar'),
      import('drizzle-orm'),
    ]);
    return { db: dbOverride ?? realDb, serpCache, ...orm };
  };
  return {
    async get(key) {
      const { db, serpCache, eq } = await load();
      const [row] = await db.select().from(serpCache).where(eq(serpCache.key, key)).limit(1);
      return row ? { payload: row.payload, fetchedAt: row.fetchedAt } : null;
    },
    async put(key, engine, payload) {
      const { db, serpCache } = await load();
      await db
        .insert(serpCache)
        .values({ key, engine, payload, fetchedAt: new Date() })
        .onConflictDoUpdate({ target: serpCache.key, set: { engine, payload, fetchedAt: new Date() } });
    },
    async countSince(since) {
      const { db, serpCache, and, gte, eq, lt, sql } = await load();
      // attempt rows are one-hour bookkeeping: drop the stale ones as we count
      void db
        .delete(serpCache)
        .where(and(eq(serpCache.engine, 'attempt'), lt(serpCache.fetchedAt, new Date(since.getTime() - 3_600_000))))
        .catch(() => {});
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(serpCache)
        .where(and(gte(serpCache.fetchedAt, since), eq(serpCache.engine, 'attempt')));
      return row?.n ?? 0;
    },
  };
}

/** Injectable seams. Tests replace them with setSerpDeps(). */
export interface SerpDeps {
  store: CacheStore;
  fetch: typeof fetch;
  env: () => Record<string, string | undefined>;
  now: () => number;
  /** account.json timeout. */
  timeoutMs: number;
  /** Per-search timeout by engine (live: a fresh google_jobs search can take 15s+ and is billed even if we hang up; keep under the 45s lease / 60s route limit).  No automatic retry: a retry is a second credit. */
  searchTimeoutMs: (engine: string) => number;
}

const defaults = (): SerpDeps => ({
  store: drizzleStore(),
  fetch: (...a) => fetch(...a),
  env: () => process.env,
  now: () => Date.now(),
  timeoutMs: 6_000,
  searchTimeoutMs: (engine) => (engine === 'google_news' ? 10_000 : engine === 'google_jobs' ? 40_000 : 15_000),
});

const mg = globalThis as unknown as {
  __serpMemo?: { at: number; left: number } | null;
  __serpAttempts?: number[];
};

// Mutated in place, never reassigned: other modules hold this object, and a reassigned
// `export let` is not seen through every module format.
// Kept on globalThis like lib/db's client, so a module loaded twice still shares one set of seams.
const g = globalThis as unknown as { __serpDeps?: SerpDeps };
export const deps: SerpDeps = (g.__serpDeps ??= defaults());
export const setSerpDeps = (d: Partial<SerpDeps>): void => {
  Object.assign(deps, d);
  mg.__serpMemo = null;
  mg.__serpAttempts = [];
};
export const resetSerpDeps = (): void => {
  Object.assign(deps, defaults());
  mg.__serpMemo = null;
  mg.__serpAttempts = [];
};

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Key = sha256(engine + sorted params), api_key and no_cache excluded. */
export function cacheKey(engine: string, params: Record<string, string>): string {
  const rest = Object.entries(params)
    .filter(([k]) => k !== 'api_key' && k !== 'no_cache')
    .sort(([a], [b]) => a.localeCompare(b));
  return sha256(`${engine}?${rest.map(([k, v]) => `${k}=${v}`).join('&')}`);
}

/** Remove the key from any string that might carry a URL or error text. */
export function scrub(text: string): string {
  let out = text.replace(/api_key=[^&\s"')]*/gi, 'api_key=***');
  const k = deps.env().SERPAPI_API_KEY;
  if (k) out = out.split(k).join('***');
  return out;
}

/* ------------------------------------------------------------ per-user hooks -- */

export const RUN_LIMITS = { runsPerDay: 3, creditsPerRun: 12 } as const;
export const runAllowed = (runsToday: number): boolean => runsToday < RUN_LIMITS.runsPerDay;
export const creditsAllowed = (usedThisRun: number, next = 1): boolean =>
  usedThisRun + next <= RUN_LIMITS.creditsPerRun;

/* -------------------------------------------------------------- account guard -- */

const MIN_LEFT = 10;
const MAX_PER_HOUR = 45;
const ACCOUNT_TTL_MS = 5 * 60_000;

/** total_searches_left from the free account.json, memoized 5 min. -1 = unknown. */
async function searchesLeft(): Promise<number> {
  const key = deps.env().SERPAPI_API_KEY;
  if (!key) return -1;
  const now = deps.now();
  const memo = mg.__serpMemo;
  if (memo && now - memo.at < ACCOUNT_TTL_MS) return memo.left;
  try {
    const row = await deps.store.get('account');
    const stored = Number((row?.payload as { total_searches_left?: unknown } | undefined)?.total_searches_left);
    if (row && now - row.fetchedAt.getTime() < ACCOUNT_TTL_MS && Number.isFinite(stored)) {
      mg.__serpMemo = { at: now, left: stored };
      return stored;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
    let res: Response;
    try {
      res = await deps.fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, {
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return -1;
    const left = Number(((await res.json()) as { total_searches_left?: unknown }).total_searches_left);
    if (!Number.isFinite(left)) return -1;
    mg.__serpMemo = { at: now, left };
    await deps.store.put('account', 'account', { total_searches_left: left });
    return left;
  } catch {
    return -1; // unknown: fail open on the monthly figure, the hourly count still binds
  }
}

/**
 * Record that a billable search is about to be sent. Counts failures, timeouts and forced
 * refreshes too (SerpApi may bill them). Best-effort: an 'attempt' row in serp_cache (shared
 * across instances) plus an in-memory list (survives a DB write failure, per instance only).
 */
export async function noteAttempt(): Promise<void> {
  const now = deps.now();
  (mg.__serpAttempts ??= []).push(now);
  try {
    await deps.store.put(`attempt:${now}:${Math.random().toString(36).slice(2)}`, 'attempt', {});
  } catch {
    // the in-memory count still binds
  }
}

/**
 * Searches attempted in the last hour: max(DB attempt rows, this instance's memory list).
 * FAILS CLOSED: if the DB count cannot be read the answer is "limit reached", so the guard
 * drops to replay mode (fixtures, zero credits) rather than spending blind. Replay itself
 * never touches the DB, so it keeps working.
 */
export async function hourUsed(): Promise<number> {
  const since = deps.now() - 3_600_000;
  const mem = (mg.__serpAttempts = (mg.__serpAttempts ?? []).filter((t) => t >= since)).length;
  try {
    return Math.max(mem, await deps.store.countSince(new Date(since)));
  } catch {
    return MAX_PER_HOUR;
  }
}

export const isBlocked = (left: number, used: number): boolean =>
  (left >= 0 && left < MIN_LEFT) || used >= MAX_PER_HOUR;

export async function budgetBlocked(): Promise<boolean> {
  const [left, used] = await Promise.all([searchesLeft(), hourUsed()]);
  return isBlocked(left, used);
}

/** left = -1 when unknown (no key, or account.json unreachable). */
export async function creditStatus(): Promise<{ left: number; hourUsed: number; mode: SerpMode }> {
  const env = deps.env();
  const [left, used] = await Promise.all([searchesLeft(), hourUsed()]);
  const replay = !env.SERPAPI_API_KEY || env.SERP_MODE === 'replay' || isBlocked(left, used);
  return { left, hourUsed: used, mode: replay ? 'replay' : 'live' };
}
