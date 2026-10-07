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
  /**
   * Single-flight: true = this caller now owns `key` and should do the upstream work; false =
   * somebody else does. A row is stale (stealable) after INFLIGHT_BARE_MS without a stored
   * search id (its owner died before submitting) or INFLIGHT_SHARED_MS with one.
   */
  claimInflight(key: string): Promise<boolean>;
  releaseInflight(key: string): Promise<void>;
}

export const INFLIGHT_BARE_MS = 20_000;
export const INFLIGHT_SHARED_MS = 5 * 60_000;

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
    async claimInflight(key) {
      const r = rows.get(key);
      if (r) {
        const shared = (r.payload as { searchId?: unknown } | null)?.searchId != null;
        const stale = Date.now() - r.fetchedAt.getTime() >= (shared ? INFLIGHT_SHARED_MS : INFLIGHT_BARE_MS);
        if (r.engine === 'inflight' && !stale) return false;
      }
      rows.set(key, { engine: 'inflight', payload: {}, fetchedAt: new Date() });
      return true;
    },
    async releaseInflight(key) {
      if (rows.get(key)?.engine === 'inflight') rows.delete(key);
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
    async claimInflight(key) {
      const { db, serpCache, sql } = await load();
      const bare = new Date(Date.now() - INFLIGHT_BARE_MS).toISOString();
      const shared = new Date(Date.now() - INFLIGHT_SHARED_MS).toISOString();
      // INSERT ... ON CONFLICT: a row comes back only if we inserted it or stole a stale one.
      const got = await db
        .insert(serpCache)
        .values({ key, engine: 'inflight', payload: {}, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: serpCache.key,
          set: { engine: 'inflight', payload: {}, fetchedAt: new Date() },
          setWhere: sql`${serpCache.engine} = 'inflight' and ${serpCache.fetchedAt} < case when ${serpCache.payload}->>'searchId' is not null then ${shared}::timestamp else ${bare}::timestamp end`,
        })
        .returning({ key: serpCache.key });
      return got.length > 0;
    },
    async releaseInflight(key) {
      const { db, serpCache, and, eq } = await load();
      await db.delete(serpCache).where(and(eq(serpCache.key, key), eq(serpCache.engine, 'inflight')));
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
  /**
   * Timeout of ONE http call to SerpApi (async submit, archive poll, or a synchronous intel
   * call). Hard-capped at 8s so a whole step stays far inside the host's function limit
   * (Netlify free ~26-30s). No automatic retry: a retry can be a second credit.
   */
  searchTimeoutMs: (engine: string) => number;
  /** Sleep, injectable so tests do not wait. */
  sleep: (ms: number) => Promise<void>;
}

export const HTTP_TIMEOUT_MS = 8_000;

/**
 * ONE http GET whose WHOLE life (connect, headers AND body) is bounded by `ms`. The timer is
 * kept until the body is parsed, and a hand-off race covers a fetch that ignores its abort
 * signal. Throws an AbortError on timeout; a non-JSON body is `json: null`.
 */
export async function fetchJson(
  url: string,
  ms: number,
): Promise<{ status: number; ok: boolean; json: ({ error?: unknown } & Record<string, unknown>) | null }> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    }, ms);
  });
  const work = (async () => {
    const res = await deps.fetch(url, { signal: ctrl.signal });
    const json = (await res.json().catch(() => null)) as ({ error?: unknown } & Record<string, unknown>) | null;
    return { status: res.status, ok: res.ok, json };
  })();
  work.catch(() => undefined); // a result that arrives after the timeout is dropped, not unhandled
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

const defaults = (): SerpDeps => ({
  store: drizzleStore(),
  fetch: (...a) => fetch(...a),
  env: () => process.env,
  now: () => Date.now(),
  // account.json is tiny and fails open: 2s keeps a cold lookup from eating an intel step.
  timeoutMs: 2_000,
  searchTimeoutMs: () => HTTP_TIMEOUT_MS,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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
    // Single-flight: parallel callers (or instances) on a cold memo make ONE account.json request.
    if (!(await deps.store.claimInflight('inflight:account'))) {
      for (let waited = 0; waited < 3_000; waited += 500) {
        await deps.sleep(500);
        const again = await deps.store.get('account');
        const v = Number((again?.payload as { total_searches_left?: unknown } | undefined)?.total_searches_left);
        if (again && deps.now() - again.fetchedAt.getTime() < ACCOUNT_TTL_MS && Number.isFinite(v)) {
          mg.__serpMemo = { at: deps.now(), left: v };
          return v;
        }
      }
      return -1; // the owner is slow or died: fail open on the monthly figure, the hourly count still binds
    }
    try {
      const res = await fetchJson(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, deps.timeoutMs);
      if (!res.ok) return -1;
      const left = Number((res.json as { total_searches_left?: unknown } | null)?.total_searches_left);
      if (!Number.isFinite(left)) return -1;
      mg.__serpMemo = { at: now, left };
      await deps.store.put('account', 'account', { total_searches_left: left });
      return left;
    } finally {
      await deps.store.releaseInflight('inflight:account').catch(() => undefined);
    }
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
 * Searches attempted in the last hour: max(DB attempt rows, this instance's memory list), or
 * null when the DB count cannot be read. null is FAIL CLOSED but is NOT "sample data": the
 * caller reports "temporarily unavailable" and never serves fixtures as if they were live.
 */
export async function hourUsed(): Promise<number | null> {
  const since = deps.now() - 3_600_000;
  const mem = (mg.__serpAttempts = (mg.__serpAttempts ?? []).filter((t) => t >= since)).length;
  try {
    return Math.max(mem, await deps.store.countSince(new Date(since)));
  } catch {
    return null;
  }
}

export const isBlocked = (left: number, used: number): boolean =>
  (left >= 0 && left < MIN_LEFT) || used >= MAX_PER_HOUR;

export type BudgetState = 'ok' | 'blocked' | 'unavailable';

/** ok = may spend; blocked = credits low or hourly cap (fixtures are honest then); unavailable = guard storage down. */
export async function budgetState(): Promise<BudgetState> {
  const [left, used] = await Promise.all([searchesLeft(), hourUsed()]);
  if (used === null) return 'unavailable';
  return isBlocked(left, used) ? 'blocked' : 'ok';
}

export async function budgetBlocked(): Promise<boolean> {
  return (await budgetState()) !== 'ok';
}

/** left = -1 when unknown (no key, or account.json unreachable); unavailable = the hourly guard could not be read. */
export async function creditStatus(): Promise<{
  left: number;
  hourUsed: number;
  mode: SerpMode;
  unavailable: boolean;
}> {
  const env = deps.env();
  const [left, used] = await Promise.all([searchesLeft(), hourUsed()]);
  const keyless = !env.SERPAPI_API_KEY || env.SERP_MODE === 'replay';
  const unavailable = !keyless && used === null;
  const replay = keyless || unavailable || isBlocked(left, used ?? 0);
  return { left, hourUsed: used ?? 0, mode: replay ? 'replay' : 'live', unavailable };
}
