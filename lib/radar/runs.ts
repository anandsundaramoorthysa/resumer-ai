/**
 * Job Radar orchestrator, executed one short step per request (same shape as
 * lib/sync/stepped.ts).
 *
 *   plan -> awaiting-queries (G1) -> search (submit) -> poll (repeats) -> rank (+market)
 *        -> intel -> select (G2) -> done
 *
 * STEP PROTOCOL (every step is far shorter than the host's function limit; see STEP_BUDGET_MS)
 *   search  submits every approved query to SerpApi in ASYNC mode (<= 8s, parallel). The
 *           credit reservation and a ledger row are persisted BEFORE each http call and the
 *           search id right after, so a killed and reclaimed step never submits a query twice.
 *   poll    one bounded GET (<= 8s, parallel) of the Search Archive per pending search, then a
 *           short pause (<= 2.5s) so the client's fast loop does not hammer. Repeats until every
 *           search settled; a search still pending 60s after its submit is warned and skipped.
 *   intel   synchronous on purpose: <= 16s (listing + news in parallel, then a rating
 *           fallback, each call hard-bounded at 8s); results are cached per call, so a re-run
 *           of a killed intel step is served from the cache.
 * Replay mode and tests complete inside the submit step (no polling needed).
 *
 * Each `advanceRadar` first CLAIMS the step with a lease (`leased_until`) and counts the
 * claim (`attempts`, in SQL), so two tabs advancing the same run cannot both do the work (or
 * spend the credits) and a step that keeps dying is failed after MAX_CLAIMS instead of looping.
 * It commits with `WHERE step = expectStep`. One query or company failing is a 'warn' and a
 * skip; only a failed plan or every search failing is a hard error. Unexpected (non-authored)
 * errors retry the step up to MAX_ATTEMPTS times before failing. Every message that can reach
 * the browser is authored here, never an upstream error string.
 *
 * Credits are RESERVED in SQL (agent_run.credits_used) before a billable call is sent, so a
 * killed, failed or all-fail run still counts toward the 12-credit run cap and the 3-runs-a-day
 * cap. Reservations are only given back when SerpApi definitively answered with an error.
 */

import type { ContactInfo, ProfileRecord, RoleRecord } from '@/lib/types';
import { BudgetExceededError } from '@/lib/ai/budget';
import { istDayStart } from '@/lib/time/ist';
import type { DraftBudget } from '@/lib/ai/budget';
import { combineJobText } from '@/lib/intake/job-input';
import { companyIntel, pollSearchJobs, submitSearchJobs } from '@/lib/serp/client';
import { RUN_LIMITS, runAllowed } from '@/lib/serp/budget';
import type {
  EmployerIntel,
  Plan,
  Posting,
  RankedPosting,
  SearchPoll,
  SearchSubmit,
  SerpResult,
  MarketSignal,
} from '@/lib/serp/types';
import {
  TERMINAL,
  appendEvents,
  boundIntel,
  boundPostings,
  emptyState,
  makeEvent,
  safeMessage,
} from './events';
import type { RadarEvent, RadarRunStatus, RadarStatus, RunState, SearchTrack } from './events';

export type { RadarEvent, RadarStatus, RunState } from './events';

/* --------------------------------------------------------------------- store -- */

export interface Run {
  id: string;
  userId: string;
  status: RadarRunStatus;
  phase: string;
  step: number;
  totalSteps: number;
  message: string;
  state: RunState;
  events: RadarEvent[];
  creditsUsed: number;
  mode: 'live' | 'replay';
  error: string;
  createdAt: Date;
  updatedAt: Date;
  /** Step lease; null = nobody is working on the current step. */
  leasedUntil: Date | null;
  /** Times the current step was claimed; reset to 0 when a step commits. */
  attempts: number;
}

export type RunInit = Omit<Run, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'leasedUntil' | 'attempts'>;
export type RunPatch = Partial<Omit<Run, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>;

/**
 * Time one step may take at most on the host. VERCEL honours route `maxDuration` (60s here).
 * NETLIFY does not: synchronous functions are cut at ~26-30s on the free plan (the site
 * default is 10s unless raised), whatever `maxDuration` says. Every step below is designed
 * for the smaller figure. The lease must outlive a step that is still legitimately running
 * (budget + margin) so it is only reclaimed once the worker is surely dead.
 */
export const STEP_BUDGET_MS = 30_000;
export const LEASE_MS = STEP_BUDGET_MS + 15_000;
/** A running run nobody advances for this long is cancelled on the next poll or start. */
export const STALE_RUNNING_MS = 10 * 60_000;
/** A run waiting on the user (a gate) is kept longer. */
export const STALE_AWAITING_MS = 60 * 60_000;
/** One step claimed more than this many times is a poison step: the run fails. */
export const MAX_CLAIMS = 6;
/** A search still Queued/Processing this long after its submit is warned and skipped. */
export const POLL_CAP_MS = 60_000;
const POLL_PAUSE_MS = 2_500;
const MAX_ATTEMPTS = 3;

const staleMs = (r: Pick<Run, 'status'>) => (r.status === 'running' ? STALE_RUNNING_MS : STALE_AWAITING_MS);

/**
 * Which runs spend the daily allowance of 3. Only a run that reached a search (it reserved or
 * spent credits) or finished counts; one cancelled or errored before any search cost
 * nothing, so it does not use up the day.
 */
export const countsTowardCap = (r: Pick<Run, 'status' | 'creditsUsed'>): boolean =>
  r.status === 'done' || r.creditsUsed > 0;

/** One billable upstream call of a run, as persisted before it is sent. */
export interface LedgerRow {
  key: string;
  q: string;
  /** '' = reserved but no id stored (submit in flight, or the worker died before storing it). */
  searchId: string;
  credits: number;
  /** ms epoch */
  submittedAt: number;
}

export interface RunStore {
  /**
   * Atomically: if the user already has an active run, return it (the partial unique index
   * in the database); else if `cap.allowed(runsCountedSince)` is false return null; else
   * insert and return the new run.
   */
  insert(userId: string, init: RunInit, cap: { since: Date; allowed(n: number): boolean }): Promise<Run | null>;
  get(userId: string, id: string): Promise<Run | null>;
  latestActive(userId: string): Promise<Run | null>;
  /**
   * Take the lease on the current step: succeeds only if the run is 'running' at `step` and
   * nobody holds an unexpired lease; increments `attempts` in the same statement. Returns
   * the run on success, null otherwise.
   */
  claim(userId: string, id: string, step: number): Promise<Run | null>;
  /** Atomic compare-and-set: applies `patch` only if user, step (and status, when given) still match. */
  update(
    id: string,
    where: { userId: string; step: number; status?: RadarRunStatus[] },
    patch: RunPatch,
  ): Promise<Run | null>;
  /**
   * Idempotent reservation of one billable call (ledger row + `credits` added to creditsUsed,
   * in one transaction). 'new' = go ahead and send it; 'exists' = it was already reserved
   * (never send it again); 'capped' = it would exceed `maxCredits`, nothing was written.
   */
  reserve(
    userId: string,
    runId: string,
    key: string,
    info: { engine: string; q: string; credits: number },
    maxCredits: number,
  ): Promise<'new' | 'exists' | 'capped'>;
  /** Fill in the search id of a reserved call. */
  setSearchId(runId: string, key: string, searchId: string): Promise<void>;
  getLedger(userId: string, runId: string): Promise<LedgerRow[]>;
  /** creditsUsed += delta (never below 0): settle a reservation. */
  addCredits(userId: string, runId: string, delta: number): Promise<void>;
}

export function memoryRunStore(
  now: () => number = Date.now,
): RunStore & { runs: Run[]; ledger: Map<string, LedgerRow & { runId: string }> } {
  const runs: Run[] = [];
  const ledger = new Map<string, LedgerRow & { runId: string }>();
  let n = 0;
  const copy = (r: Run): Run => structuredClone(r);
  const active = (userId: string) =>
    runs.filter((x) => x.userId === userId && !TERMINAL.includes(x.status)).at(-1);
  const own = (userId: string, id: string) => runs.find((x) => x.id === id && x.userId === userId);
  return {
    runs,
    ledger,
    async insert(userId, init, cap) {
      const open = active(userId);
      if (open) return copy(open);
      const counted = runs.filter(
        (x) => x.userId === userId && x.createdAt.getTime() >= cap.since.getTime() && countsTowardCap(x),
      ).length;
      if (!cap.allowed(counted)) return null;
      const t = new Date(now());
      const run: Run = {
        ...structuredClone(init),
        id: `run-${++n}`,
        userId,
        createdAt: t,
        updatedAt: t,
        leasedUntil: null,
        attempts: 0,
      };
      runs.push(run);
      return copy(run);
    },
    async get(userId, id) {
      const r = own(userId, id);
      return r ? copy(r) : null;
    },
    async latestActive(userId) {
      const r = active(userId);
      return r ? copy(r) : null;
    },
    async claim(userId, id, step) {
      const r = own(userId, id);
      if (!r || r.step !== step || r.status !== 'running') return null;
      if (r.leasedUntil && r.leasedUntil.getTime() >= now()) return null;
      r.leasedUntil = new Date(now() + LEASE_MS);
      r.attempts += 1;
      return copy(r);
    },
    async update(id, where, patch) {
      const r = runs.find((x) => x.id === id && x.userId === where.userId);
      if (!r || r.step !== where.step || (where.status && !where.status.includes(r.status))) return null;
      Object.assign(r, structuredClone(patch), { updatedAt: new Date(now()) });
      return copy(r);
    },
    async reserve(userId, runId, key, info, maxCredits) {
      const r = own(userId, runId);
      if (!r) throw new Error('That run was not found.');
      if (ledger.has(`${runId}:${key}`)) return 'exists';
      if (r.creditsUsed + info.credits > maxCredits) return 'capped';
      ledger.set(`${runId}:${key}`, { runId, key, q: info.q, searchId: '', credits: info.credits, submittedAt: now() });
      r.creditsUsed += info.credits;
      return 'new';
    },
    async setSearchId(runId, key, searchId) {
      const row = ledger.get(`${runId}:${key}`);
      if (row && !row.searchId) row.searchId = searchId;
    },
    async getLedger(userId, runId) {
      if (!own(userId, runId)) return [];
      return [...ledger.values()].filter((x) => x.runId === runId).map((x) => ({ key: x.key, q: x.q, searchId: x.searchId, credits: x.credits, submittedAt: x.submittedAt }));
    },
    async addCredits(userId, runId, delta) {
      const r = own(userId, runId);
      if (r) r.creditsUsed = Math.max(0, r.creditsUsed + delta);
    },
  };
}

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const c = e?.code ?? e?.cause?.code;
  return typeof c === 'string' ? c : undefined;
};

class CappedSignal extends Error {}

// Opportunistic serp_cache eviction: at most once per process-hour, never blocks or throws.
// (The scheduled pruneRadarData in housekeeping.ts is the real retention; this is a backstop.)
let lastEvict = 0;

// dbOverride is a test seam (scripts/verify-radar-db.mts); production passes nothing.
export function drizzleRunStore(dbOverride?: typeof import('@/lib/db').db): RunStore {
  const load = async () => {
    const [{ db: realDb }, { agentRuns, serpCache, radarSearches }, orm] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/db/schema-radar'),
      import('drizzle-orm'),
    ]);
    return { db: dbOverride ?? realDb, agentRuns, serpCache, radarSearches, ...orm };
  };
  type Row = typeof import('@/lib/db/schema-radar').agentRuns.$inferSelect;
  const toRun = (r: Row): Run => ({
    id: r.id,
    userId: r.userId,
    status: r.status as RadarRunStatus,
    phase: r.phase,
    step: r.step,
    totalSteps: r.totalSteps,
    message: r.message,
    state: { ...emptyState(false), ...(r.state as Partial<RunState>) },
    events: r.events,
    creditsUsed: r.creditsUsed,
    mode: r.mode === 'replay' ? 'replay' : 'live',
    error: r.error,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    leasedUntil: r.leasedUntil,
    attempts: r.attempts,
  });
  const latestActive = async (userId: string): Promise<Run | null> => {
    const { db, agentRuns, and, desc, eq, inArray } = await load();
    const [row] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.userId, userId), inArray(agentRuns.status, ['running', 'awaiting'])))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    return row ? toRun(row) : null;
  };
  return {
    async insert(userId, init, cap) {
      const { db, agentRuns, serpCache, and, eq, gt, gte, lt, ne, or, sql } = await load();
      if (Date.now() - lastEvict > 3_600_000) {
        lastEvict = Date.now();
        // ponytail: fire and forget; a failed sweep is retried next hour.
        void Promise.resolve(
          db
            .delete(serpCache)
            .where(and(lt(serpCache.fetchedAt, new Date(Date.now() - 24 * 3_600_000)), ne(serpCache.engine, 'account'))),
        ).catch(() => undefined);
      }
      try {
        const row = await db.transaction(async (tx) => {
          // Serialises this user's starts, so the cap count and the insert cannot interleave.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
          const [c] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.userId, userId),
                gte(agentRuns.createdAt, cap.since),
                or(eq(agentRuns.status, 'done'), gt(agentRuns.creditsUsed, 0)),
              ),
            );
          if (!cap.allowed(c?.n ?? 0)) return null;
          const [r] = await tx
            .insert(agentRuns)
            .values({ ...init, userId, state: init.state as unknown as Record<string, unknown> })
            .returning();
          return r;
        });
        return row ? toRun(row) : null;
      } catch (err) {
        // The partial unique index: another start won the race. Hand back its run.
        if (pgCode(err) === '23505') return latestActive(userId);
        throw err;
      }
    },
    async get(userId, id) {
      const { db, agentRuns, and, eq } = await load();
      const [row] = await db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, id), eq(agentRuns.userId, userId)))
        .limit(1);
      return row ? toRun(row) : null;
    },
    latestActive,
    async claim(userId, id, step) {
      const { db, agentRuns, and, eq, isNull, lt, or, sql } = await load();
      const [row] = await db
        .update(agentRuns)
        .set({
          leasedUntil: sql`now() + interval '${sql.raw(String(LEASE_MS / 1000))} seconds'`,
          attempts: sql`${agentRuns.attempts} + 1`,
        })
        .where(
          and(
            eq(agentRuns.id, id),
            eq(agentRuns.userId, userId),
            eq(agentRuns.step, step),
            eq(agentRuns.status, 'running'),
            or(isNull(agentRuns.leasedUntil), lt(agentRuns.leasedUntil, sql`now()`)),
          ),
        )
        .returning();
      return row ? toRun(row) : null;
    },
    async update(id, where, patch) {
      const { db, agentRuns, and, eq, inArray } = await load();
      const conds = [eq(agentRuns.id, id), eq(agentRuns.userId, where.userId), eq(agentRuns.step, where.step)];
      if (where.status) conds.push(inArray(agentRuns.status, where.status));
      const [row] = await db
        .update(agentRuns)
        .set({ ...patch, state: patch.state as unknown as Record<string, unknown> | undefined, updatedAt: new Date() })
        .where(and(...conds))
        .returning();
      return row ? toRun(row) : null;
    },
    async reserve(userId, runId, key, info, maxCredits) {
      const { db, agentRuns, radarSearches, and, eq, sql } = await load();
      try {
        return await db.transaction(async (tx) => {
          const ins = await tx
            .insert(radarSearches)
            .values({ runId, key, engine: info.engine, q: info.q, credits: info.credits })
            .onConflictDoNothing()
            .returning({ key: radarSearches.key });
          if (ins.length === 0) return 'exists' as const;
          const upd = await tx
            .update(agentRuns)
            .set({ creditsUsed: sql`${agentRuns.creditsUsed} + ${info.credits}` })
            .where(
              and(
                eq(agentRuns.id, runId),
                eq(agentRuns.userId, userId),
                sql`${agentRuns.creditsUsed} + ${info.credits} <= ${maxCredits}`,
              ),
            )
            .returning({ id: agentRuns.id });
          if (upd.length === 0) throw new CappedSignal(); // rolls the ledger insert back
          return 'new' as const;
        });
      } catch (err) {
        if (err instanceof CappedSignal) return 'capped';
        throw err;
      }
    },
    async setSearchId(runId, key, searchId) {
      const { db, radarSearches, and, eq } = await load();
      await db
        .update(radarSearches)
        .set({ searchId })
        .where(and(eq(radarSearches.runId, runId), eq(radarSearches.key, key), eq(radarSearches.searchId, '')));
    },
    async getLedger(userId, runId) {
      const { db, agentRuns, radarSearches, and, eq } = await load();
      const rows = await db
        .select({
          key: radarSearches.key,
          q: radarSearches.q,
          searchId: radarSearches.searchId,
          credits: radarSearches.credits,
          submittedAt: radarSearches.submittedAt,
        })
        .from(radarSearches)
        .innerJoin(agentRuns, eq(agentRuns.id, radarSearches.runId))
        .where(and(eq(radarSearches.runId, runId), eq(agentRuns.userId, userId)));
      return rows.map((r) => ({ ...r, submittedAt: r.submittedAt.getTime() }));
    },
    async addCredits(userId, runId, delta) {
      const { db, agentRuns, and, eq, sql } = await load();
      await db
        .update(agentRuns)
        .set({ creditsUsed: sql`greatest(0, ${agentRuns.creditsUsed} + ${delta})` })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));
    },
  };
}

/* ---------------------------------------------------------------------- deps -- */

export interface Profile {
  records: ProfileRecord[];
  roles: RoleRecord[];
  contact: ContactInfo;
}

export interface RadarDeps {
  store: RunStore;
  now(): number;
  /** Pause between poll rounds; injectable so tests do not wait. */
  sleep(ms: number): Promise<void>;
  loadProfile(userId: string): Promise<Profile>;
  buildProfileDigest(records: ProfileRecord[], roles: RoleRecord[], contact: ContactInfo): string;
  planSearch(a: { digest: string; roles: RoleRecord[]; contact: ContactInfo; budget: DraftBudget }): Promise<Plan>;
  /** The deterministic plan used when the AI allowance is spent. */
  rulesPlan(digest: string, roles: RoleRecord[], contact: ContactInfo): Plan;
  rankPostings(postings: Posting[], p: Profile, topK?: number): RankedPosting[];
  marketSignal(postings: Posting[], heldKeywords: string[]): MarketSignal;
  /** Async submit (<= 8s): a result (cache/replay), or a search id to poll. See lib/serp/client.ts. */
  submitSearch(
    q: string,
    o: {
      userId: string;
      fromQuery: number;
      reserve(): Promise<boolean>;
      stored(searchId: string): Promise<void>;
    },
  ): Promise<SearchSubmit>;
  /** One bounded archive read (<= 8s). */
  pollSearch(q: string, o: { searchId: string; fromQuery: number }): Promise<SearchPoll>;
  companyIntel(company: string, serpJobId: string, userId: string): Promise<SerpResult<EmployerIntel>>;
  /** Primes the SerpApi account.json memo once, so parallel lookups do not race it. */
  warmBudget(): Promise<void>;
  /** Daily AI allowance gate and recorder for the one planner call. */
  newBudget(userId: string): DraftBudget;
  aiAssert(userId: string): Promise<void>;
  aiRecord(userId: string, budget: DraftBudget): Promise<void>;
}

const defaultDeps: RadarDeps = {
  store: drizzleRunStore(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async loadProfile(userId) {
    const { loadProfileForUser } = await import('@/lib/server/profile');
    return loadProfileForUser(userId);
  },
  buildProfileDigest: (...a) => requireSync().buildProfileDigest(...a),
  planSearch: async (a) => (await import('./planner')).planSearch(a),
  rulesPlan: (...a) => requireSync().rulesPlan(...a),
  rankPostings: (...a) => requireSync().rankPostings(...a),
  marketSignal: (...a) => requireSync().marketSignal(...a),
  submitSearch: submitSearchJobs,
  pollSearch: pollSearchJobs,
  companyIntel,
  async warmBudget() {
    try {
      await (await import('@/lib/serp/budget')).budgetBlocked();
    } catch {
      /* the lookups decide for themselves */
    }
  },
  newBudget: (userId) => requireSync().newBudget(userId),
  async aiAssert(userId) {
    const { assertDailyBudget } = await import('@/lib/ai/daily-budget');
    await assertDailyBudget(userId);
  },
  async aiRecord(_userId, budget) {
    // Metered: usage was billed call by call (a killed plan step is not free); this sends the remainder.
    await (budget as import('@/lib/pipeline/metered-budget').MeteredBudget).flush();
  },
};

// ponytail: the pure agents are loaded once at first use (top-level await would break
// test stubs that never touch them); preload() is called by the async entry points.
type Pure = {
  buildProfileDigest: RadarDeps['buildProfileDigest'];
  rulesPlan: RadarDeps['rulesPlan'];
  rankPostings: RadarDeps['rankPostings'];
  marketSignal: RadarDeps['marketSignal'];
  newBudget: (userId: string) => DraftBudget;
};
let pure: Pure | null = null;
const requireSync = (): Pure => {
  if (!pure) throw new Error('Radar agents are not loaded.');
  return pure;
};
async function preload(d: RadarDeps): Promise<void> {
  if (d !== defaultDeps || pure) return;
  const [planner, ranker, market, metered, daily] = await Promise.all([
    import('./planner'),
    import('./ranker'),
    import('./market'),
    import('@/lib/pipeline/metered-budget'),
    import('@/lib/ai/daily-budget'),
  ]);
  pure = {
    buildProfileDigest: planner.buildProfileDigest,
    rulesPlan: planner.rulesPlan,
    rankPostings: ranker.rankPostings,
    marketSignal: market.marketSignal,
    // Fast and small: one planner call, a few seconds, nothing held back for rendering.
    newBudget: (userId) =>
      new metered.MeteredBudget((u) => daily.recordDailyUsage(userId, u), { maxCalls: 3, maxTokens: 20_000 }, 6_500, 0, userId),
  };
}

/* ------------------------------------------------------------------- helpers -- */

const INTEL_TOP = 2;
const INTEL_CREDITS = 3;
const QUERY_MAX_CHARS = 120;
/**
 * plan, G1, search, poll, rank, [intel], G2, done. The poll step repeats (once per round), so
 * `step` can pass this on a slow search: a progress label must clamp, the counter must not.
 */
const totalFor = (intel: boolean) => (intel ? 7 : 6);

function toStatus(run: Run): RadarStatus {
  const s = run.state;
  return {
    runId: run.id,
    status: run.status,
    phase: run.phase,
    step: run.step,
    totalSteps: run.totalSteps,
    message: run.message,
    gate: run.status === 'awaiting' ? s.gate : '',
    events: run.events,
    // Descriptions are only needed server-side (selectPosting); keep polls light.
    state: { ...s, postings: s.postings.map((p) => ({ ...p, description: p.description.slice(0, 300) })) },
    creditsUsed: run.creditsUsed,
    mode: run.mode,
    error: run.error,
  };
}

/**
 * The daily cap resets at midnight IST (Asia/Kolkata, UTC+05:30, no DST), i.e. 18:30 UTC:
 * the product's users are in India, so "today" is their calendar day.
 */
export { istDayStart };

const skillNames = (records: ProfileRecord[]) =>
  records.flatMap((r) => (r.type === 'skill' ? [r.name] : []));

/**
 * Cancel a run that has made no progress: 10 minutes while running (its client loop is gone),
 * an hour while waiting at a gate. Returns the cancelled run, or null if it is still alive.
 */
async function cancelIfStale(run: Run, d: RadarDeps): Promise<Run | null> {
  if (TERMINAL.includes(run.status) || d.now() - run.updatedAt.getTime() <= staleMs(run)) return null;
  const mins = Math.round(staleMs(run) / 60_000);
  const next = await d.store.update(
    run.id,
    { userId: run.userId, step: run.step },
    {
      status: 'cancelled',
      message: 'Cancelled',
      step: run.step + 1,
      leasedUntil: null,
      events: appendEvents(run.events, [
        makeEvent(d.now(), 'info', run.phase, `Cancelled: no activity for ${mins} minutes`, 'radar'),
      ]),
    },
  );
  return next ?? (await d.store.get(run.userId, run.id)) ?? run;
}

/** The user's active run, auto-cancelling one that has made no progress (see cancelIfStale). */
async function activeRun(userId: string, d: RadarDeps): Promise<Run | null> {
  const run = await d.store.latestActive(userId);
  if (!run) return null;
  return (await cancelIfStale(run, d)) ? null : run;
}

/* ---------------------------------------------------------------------- start -- */

export async function startRadar(
  userId: string,
  opts: { intel?: boolean } = {},
  d: RadarDeps = defaultDeps,
): Promise<RadarStatus> {
  const existing = await activeRun(userId, d);
  if (existing) return toStatus(existing);

  const intel = opts.intel !== false;
  const run = await d.store.insert(
    userId,
    {
      status: 'running',
      phase: 'plan',
      step: 0,
      totalSteps: totalFor(intel),
      message: 'Planning your searches…',
      state: emptyState(intel),
      events: [makeEvent(d.now(), 'info', 'plan', 'Run started', 'radar')],
      creditsUsed: 0,
      mode: 'live',
      error: '',
    },
    { since: istDayStart(d.now()), allowed: runAllowed },
  );
  if (!run) {
    throw new Error(
      `You have used today's ${RUN_LIMITS.runsPerDay} Job Radar runs. They reset at midnight IST (Asia/Kolkata).`,
    );
  }
  return toStatus(run);
}

/* -------------------------------------------------------------------- advance -- */

type Work = RunPatch & { events?: RadarEvent[] };

export async function advanceRadar(
  userId: string,
  runId: string,
  expectStep: number,
  d: RadarDeps = defaultDeps,
): Promise<RadarStatus> {
  const run = await d.store.get(userId, runId);
  if (!run) throw new Error('That run was not found.');
  // Two tabs, a retry, a cancelled or finished run, or a run waiting on the user: no work.
  if (run.status !== 'running' || run.step !== expectStep) return toStatus(run);

  // Only the claim winner works. A loser (another tab mid-step) just reports the run.
  const mine = await d.store.claim(userId, runId, expectStep);
  if (!mine) return toStatus((await d.store.get(userId, runId)) ?? run);

  let work: Work;
  if (mine.attempts > MAX_CLAIMS) {
    // A step claimed again and again without ever committing is dying mid-flight (killed host,
    // poison data). Stop here: every further claim could be billed.
    console.error('[radar] poison step for user', userId, 'phase', run.phase, 'claims', mine.attempts);
    const error = 'The radar stopped on our side. Try again in a minute.';
    work = { status: 'error', message: 'Radar failed', error, events: [makeEvent(d.now(), 'error', run.phase, error, 'radar')] };
  } else {
    try {
      await preload(d);
      work = await runStep(mine, d);
      // A clean step ends any run of transient failures.
      const st = work.state ?? mine.state;
      if (st.retries) work = { ...work, state: { ...st, retries: 0 } };
    } catch (err) {
      if (isBudgetError(err)) {
        // Not a run failure (burst limit etc.): free the step so the client's retry can claim it.
        await d.store.update(
          run.id,
          { userId, step: run.step, status: ['running'] },
          { leasedUntil: null, attempts: Math.max(0, mine.attempts - 1) },
        );
        throw err;
      }
      console.error('[radar] step failed for user', userId, 'phase', run.phase, err);
      const attempts = mine.state.retries + 1;
      // A plain Error is a sentence written for the user (nothing to search for...): final.
      // Anything else (DB blip, unexpected throw) may pass on a second try.
      if (!(err instanceof Error && err.constructor === Error) && attempts < MAX_ATTEMPTS) {
        work = {
          state: { ...mine.state, retries: attempts },
          events: [makeEvent(d.now(), 'warn', run.phase, 'A step hit a snag, trying again', 'radar')],
        };
      } else {
        const error = safeMessage(err, 'The radar stopped on our side. Try again in a minute.');
        work = {
          status: 'error',
          message: 'Radar failed',
          error,
          events: [makeEvent(d.now(), 'error', run.phase, error, 'radar')],
        };
      }
    }
  }

  const { events: add = [], ...patch } = work;
  const next = await d.store.update(
    run.id,
    { userId, step: run.step, status: ['running'] },
    { ...patch, step: run.step + 1, leasedUntil: null, attempts: 0, events: appendEvents(run.events, add) },
  );
  // Cancelled (or otherwise moved) while we worked: report whatever won.
  return toStatus(next ?? (await d.store.get(userId, runId)) ?? run);
}

// Name check too: the class can be loaded twice (bundled route + dynamic import).
const isBudgetError = (e: unknown): e is BudgetExceededError =>
  e instanceof BudgetExceededError || (e instanceof Error && e.name === 'BudgetExceededError');

const failed = (): SerpResult<never> => ({ ok: false, reason: 'failed', message: 'lookup threw' });

const NOT_AVAILABLE = 'Search is temporarily unavailable.';

async function runStep(run: Run, d: RadarDeps): Promise<Work> {
  const s = run.state;
  const ev = (level: RadarEvent['level'], message: string, source?: string) =>
    makeEvent(d.now(), level, run.phase, message, source);

  /* plan */
  if (run.phase === 'plan') {
    const profile = await d.loadProfile(run.userId);
    const digest = d.buildProfileDigest(profile.records, profile.roles, profile.contact);
    const events: RadarEvent[] = [];
    let plan: Plan;
    let capped = false;
    try {
      await d.aiAssert(run.userId);
    } catch (err) {
      // The daily AI allowance is spent: that is no reason to lose the run. Burst limits
      // and approval problems are not, and go to the caller.
      if (isBudgetError(err) && err.scope === 'daily') capped = true;
      else throw err;
    }
    if (capped) {
      plan = d.rulesPlan(digest, profile.roles, profile.contact);
      events.push(ev('info', 'AI allowance reached, using a rules-based plan', 'planner'));
    } else {
      const budget = d.newBudget(run.userId);
      try {
        plan = await d.planSearch({ digest, roles: profile.roles, contact: profile.contact, budget });
      } finally {
        await d.aiRecord(run.userId, budget);
      }
    }
    const queries = plan.queries.slice(0, 3);
    if (queries.length === 0) {
      throw new Error('Add a role or skill to your profile first, so there is something to search for.');
    }
    events.push(ev('info', `Planned ${queries.length} search${queries.length > 1 ? 'es' : ''}`, 'planner'));
    return {
      status: 'awaiting',
      phase: 'awaiting-queries',
      message: 'Review the searches before they run',
      totalSteps: totalFor(s.intelOn),
      state: { ...s, plan, queries, gate: 'queries' },
      events,
    };
  }

  /* search: submit every approved query (async), idempotently */
  if (run.phase === 'search') {
    const events: RadarEvent[] = [];
    let { mode } = run;
    let postings = s.postings;
    let okQueries = s.okQueries;
    const tracks: SearchTrack[] = [];
    const jobs: { q: string; i: number }[] = [];

    // A reclaimed step finds what the dead one already reserved: reuse its search id, and
    // NEVER submit that query again (a reservation without an id is a lost submit: skip it).
    const ledger = new Map((await d.store.getLedger(run.userId, run.id)).map((r) => [r.key, r]));
    s.queries.forEach((q, i) => {
      const row = ledger.get(`q${i}`);
      if (!row) {
        jobs.push({ q: q.q, i });
      } else if (row.searchId) {
        tracks.push({ i, q: q.q, searchId: row.searchId, submittedAt: row.submittedAt, status: 'pending', credits: row.credits });
      } else {
        tracks.push({ i, q: q.q, searchId: '', submittedAt: row.submittedAt, status: 'failed', credits: row.credits });
        events.push(ev('warn', `Search "${q.q}" was interrupted and is not retried, to avoid a second charge`, 'serpapi:google_jobs'));
      }
    });

    // ponytail: one account.json lookup up front, so the parallel searches read its memo.
    if (jobs.length > 1) await d.warmBudget();
    const outcomes = await Promise.all(
      jobs.map(async (j) => {
        let reserved = false;
        const key = `q${j.i}`;
        const o = await d
          .submitSearch(j.q, {
            userId: run.userId,
            fromQuery: j.i,
            reserve: async () => {
              const r = await d.store.reserve(run.userId, run.id, key, { engine: 'google_jobs', q: j.q, credits: 1 }, RUN_LIMITS.creditsPerRun);
              reserved = r === 'new';
              return reserved;
            },
            stored: (id) => d.store.setSearchId(run.id, key, id),
          })
          .catch((): SearchSubmit => ({ kind: 'result', result: failed() }));
        return { j, o, reserved };
      }),
    );

    let unavailable = 0;
    for (const { j, o, reserved } of outcomes) {
      const { q } = j;
      const track = (status: SearchTrack['status'], searchId = '', credits = 0) =>
        tracks.push({ i: j.i, q, searchId, submittedAt: d.now(), status, credits });
      if (o.kind === 'declined') {
        events.push(ev('warn', `Skipped "${q}": this run's credit limit was reached`, 'serpapi:google_jobs'));
        track('failed');
      } else if (o.kind === 'pending') {
        track('pending', o.searchId, reserved ? 1 : 0);
      } else if (!o.result.ok) {
        const r = o.result;
        // SerpApi answered with an error: the reserved credit was never billed.
        if (reserved && r.refund) await d.store.addCredits(run.userId, run.id, -1);
        if (r.reason === 'unavailable') {
          unavailable += 1;
          events.push(ev('warn', `Search "${q}" skipped: ${NOT_AVAILABLE}`, 'serpapi:google_jobs'));
        } else {
          events.push(ev('warn', `Search "${q}" failed (${r.reason}), skipped`, 'serpapi:google_jobs'));
        }
        track('failed', '', reserved && !r.refund ? 1 : 0);
      } else {
        const r = o.result;
        const delta = r.credits - (reserved ? 1 : 0);
        if (delta !== 0) await d.store.addCredits(run.userId, run.id, delta);
        okQueries += 1;
        const seen = new Set(postings.map((p) => p.key));
        const fresh = r.data.filter((p) => !seen.has(p.key) && seen.add(p.key));
        postings = boundPostings([...postings, ...fresh]);
        if (r.mode === 'replay' && mode !== 'replay') {
          mode = 'replay';
          events.push(ev('warn', 'Credits low, showing sample data', 'serpapi'));
        }
        events.push(
          ev('info', `"${q}": ${r.data.length} postings, ${fresh.length} new${r.cached ? ' (cached)' : ''}`, 'serpapi:google_jobs'),
        );
        track('done', '', r.credits);
      }
    }
    tracks.sort((a, b) => a.i - b.i);

    const pending = tracks.filter((t) => t.status === 'pending').length;
    if (pending === 0 && okQueries === 0) {
      if (unavailable > 0 && unavailable === jobs.length) {
        throw new Error(`${NOT_AVAILABLE} Nothing was spent. Try again in a few minutes.`);
      }
      throw new Error('Job search is unavailable right now. Nothing was spent beyond this run. Try again later.');
    }
    const base = { state: { ...s, postings, okQueries, searches: tracks }, mode, events };
    return pending > 0
      ? { ...base, phase: 'poll', message: `Waiting for ${pending} search${pending > 1 ? 'es' : ''} to finish…` }
      : { ...base, phase: 'rank', message: 'Ranking against your profile…' };
  }

  /* poll: one bounded archive read per pending search; repeats until all settled */
  if (run.phase === 'poll') {
    const events: RadarEvent[] = [];
    let { mode } = run;
    let postings = s.postings;
    let okQueries = s.okQueries;
    const tracks = s.searches.map((t) => ({ ...t }));
    const pending = tracks.filter((t) => t.status === 'pending');
    const polls = await Promise.all(
      pending.map((t) =>
        d.pollSearch(t.q, { searchId: t.searchId, fromQuery: t.i }).catch((): SearchPoll => ({ kind: 'pending' })),
      ),
    );
    for (const [n, t] of pending.entries()) {
      const p = polls[n];
      if (p.kind === 'pending') {
        if (d.now() - t.submittedAt > POLL_CAP_MS) {
          t.status = 'failed';
          events.push(ev('warn', `Search "${t.q}" did not finish within ${POLL_CAP_MS / 1000}s, skipped`, 'serpapi:google_jobs'));
        }
        continue;
      }
      const r = p.result;
      if (!r.ok) {
        t.status = 'failed';
        if (r.refund && t.credits > 0) await d.store.addCredits(run.userId, run.id, -t.credits);
        events.push(ev('warn', `Search "${t.q}" failed (${r.reason}), skipped`, 'serpapi:google_jobs'));
        continue;
      }
      t.status = 'done';
      okQueries += 1;
      const seen = new Set(postings.map((x) => x.key));
      const fresh = r.data.filter((x) => !seen.has(x.key) && seen.add(x.key));
      postings = boundPostings([...postings, ...fresh]);
      if (r.mode === 'replay' && mode !== 'replay') {
        mode = 'replay';
        events.push(ev('warn', 'Credits low, showing sample data', 'serpapi'));
      }
      events.push(
        ev('info', `"${t.q}": ${r.data.length} postings, ${fresh.length} new${r.cached ? ' (cached)' : ''}`, 'serpapi:google_jobs'),
      );
    }
    const state = { ...s, postings, okQueries, searches: tracks };
    const left = tracks.filter((t) => t.status === 'pending').length;
    if (left > 0) {
      // Still waiting: a short pause keeps the client's fast loop from hammering SerpApi.
      await d.sleep(POLL_PAUSE_MS);
      return {
        state,
        mode,
        events,
        message: `Waiting for ${left} search${left > 1 ? 'es' : ''} to finish…`,
      };
    }
    if (okQueries === 0) {
      throw new Error('Job search is unavailable right now. Nothing was spent beyond this run. Try again later.');
    }
    return { phase: 'rank', message: 'Ranking against your profile…', state, mode, events };
  }

  /* rank + market */
  if (run.phase === 'rank') {
    const profile = await d.loadProfile(run.userId);
    let ranked: RankedPosting[];
    let market: ReturnType<RadarDeps['marketSignal']>;
    try {
      ranked = d.rankPostings(s.postings, profile, 5);
      market = d.marketSignal(s.postings, skillNames(profile.records));
    } catch (err) {
      console.error('[radar] rank failed for user', run.userId, err);
      // A plain Error is final and shown as written: no retry, so nothing more is spent.
      throw new Error(
        'Ranking failed on this profile record data; no more credits were used. Credits already spent on the search are not refunded.',
      );
    }
    const byKey = new Map(s.postings.map((p) => [p.key, p]));
    const targets: RunState['intelTargets'] = [];
    for (const r of ranked) {
      const p = byKey.get(r.key);
      if (p && !targets.some((t) => t.company === p.company)) targets.push({ company: p.company, serpJobId: p.serpJobId });
      if (targets.length >= INTEL_TOP) break;
    }
    const intelTargets = s.intelOn ? targets : [];
    const events = [
      ev('info', `Ranked ${s.postings.length} postings, top ${ranked.length} kept`, 'ranker'),
      ev('info', `Market signal from ${market.sampleSize} postings`, 'market'),
    ];
    const state = { ...s, ranked, market, intelTargets };
    if (intelTargets.length) {
      return {
        phase: 'intel',
        message: `Checking ${intelTargets.map((t) => t.company).join(' and ')}…`,
        totalSteps: totalFor(true),
        state,
        events,
      };
    }
    return {
      status: 'awaiting',
      phase: 'select',
      message: 'Pick a posting to tailor your resume to',
      totalSteps: totalFor(false),
      state: { ...state, gate: 'select' },
      events,
    };
  }

  /* intel: every company at once (synchronous, each call <= 8s; see lib/serp/client.ts) */
  if (run.phase === 'intel') {
    const events: RadarEvent[] = [];
    let { mode } = run;
    let intel = s.intel;
    const ledger = new Set((await d.store.getLedger(run.userId, run.id)).map((r) => r.key));
    const results = await Promise.all(
      s.intelTargets.map(async (t, n) => {
        const key = `i${n}`;
        // Already reserved by a step that died: do not reserve (or count) it twice. The calls
        // themselves are cached, so re-running them is free when they had completed.
        let reserved = false;
        if (!ledger.has(key)) {
          const r = await d.store.reserve(run.userId, run.id, key, { engine: 'intel', q: t.company, credits: INTEL_CREDITS }, RUN_LIMITS.creditsPerRun);
          if (r === 'capped') return { t, skipped: true as const };
          reserved = r === 'new';
        }
        const res = await d.companyIntel(t.company, t.serpJobId, run.userId).catch(failed);
        if (reserved) {
          // Settle the reservation to what was really billed. A plain failure may still have been billed.
          const actual = res.ok ? res.credits : res.reason === 'failed' ? INTEL_CREDITS : 0;
          if (actual !== INTEL_CREDITS) await d.store.addCredits(run.userId, run.id, actual - INTEL_CREDITS);
        }
        return { t, skipped: false as const, res };
      }),
    );
    for (const x of results) {
      const { t } = x;
      if (x.skipped) {
        events.push(ev('warn', `Skipped ${t.company}: this run's credit limit was reached`, 'serpapi:google_jobs_listing'));
        continue;
      }
      const r = x.res;
      if (!r.ok) {
        events.push(ev('warn', `Could not look up ${t.company} (${r.reason}), skipped`, 'serpapi:google_news'));
        continue;
      }
      intel = [...intel, boundIntel(r.data)];
      if (r.mode === 'replay' && mode !== 'replay') {
        mode = 'replay';
        events.push(ev('warn', 'Credits low, showing sample data', 'serpapi'));
      }
      events.push(ev('info', `${t.company}: ${r.data.rating ? `${r.data.rating} on ${r.data.ratingSource}, ` : 'no rating, '}${r.data.headlines.length} headlines`, 'serpapi:google_news'));
    }
    return {
      status: 'awaiting',
      phase: 'select',
      message: 'Pick a posting to tailor your resume to',
      state: { ...s, intel, gate: 'select' },
      mode,
      events,
    };
  }

  throw new Error('This run is in a state that cannot continue.');
}

/* ---------------------------------------------------------------- gates, etc. -- */

async function gateUpdate(
  run: Run,
  patch: RunPatch,
  d: RadarDeps,
  add: RadarEvent[] = [],
): Promise<Run> {
  const next = await d.store.update(
    run.id,
    { userId: run.userId, step: run.step, status: ['awaiting'] },
    { ...patch, step: run.step + 1, attempts: 0, events: appendEvents(run.events, add) },
  );
  return next ?? (await d.store.get(run.userId, run.id)) ?? run;
}

export async function approveQueries(
  userId: string,
  runId: string,
  queries: Array<string | { q: string; why?: string }>,
  d: RadarDeps = defaultDeps,
): Promise<RadarStatus> {
  const run = await d.store.get(userId, runId);
  if (!run) throw new Error('That run was not found.');
  if (run.status !== 'awaiting' || run.state.gate !== 'queries') return toStatus(run);

  const why = new Map(run.state.queries.map((x) => [x.q, x.why]));
  const seen = new Set<string>();
  const clean = queries
    .map((x) => (typeof x === 'string' ? { q: x, why: '' } : { q: x.q, why: x.why ?? '' }))
    .map((x) => ({ q: String(x.q).replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX_CHARS), why: x.why }))
    .filter((x) => x.q && !seen.has(x.q.toLowerCase()) && seen.add(x.q.toLowerCase()))
    .slice(0, 3)
    .map((x) => ({ q: x.q, why: why.get(x.q) ?? x.why.slice(0, 200) }));
  if (clean.length === 0) throw new Error('Keep at least one search to run.');

  const next = await gateUpdate(
    run,
    {
      status: 'running',
      phase: 'search',
      message: clean.length > 1 ? `Searching ${clean.length} queries…` : `Searching: ${clean[0].q}`,
      totalSteps: totalFor(run.state.intelOn),
      state: { ...run.state, queries: clean, gate: '', searches: [] },
    },
    d,
    [makeEvent(d.now(), 'info', 'awaiting-queries', `Approved ${clean.length} search${clean.length > 1 ? 'es' : ''}`, 'radar')],
  );
  return toStatus(next);
}

export function formatPosting(p: Posting): string {
  return [
    p.title,
    [p.company, p.location].filter(Boolean).join(' · '),
    p.highlights.length ? `\n${p.highlights.map((h) => `- ${h}`).join('\n')}` : '',
    `\n${p.description}`,
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export async function selectPosting(
  userId: string,
  runId: string,
  key: string,
  d: RadarDeps = defaultDeps,
): Promise<RadarStatus & { jobText: string }> {
  const run = await d.store.get(userId, runId);
  if (!run) throw new Error('That run was not found.');
  const posting = run.state.postings.find((p) => p.key === key);
  if (!posting) throw new Error('That posting is not part of this run.');
  const jobText = combineJobText(formatPosting(posting), '').text;

  if (run.status === 'awaiting' && run.state.gate === 'select') {
    const next = await gateUpdate(
      run,
      {
        status: 'done',
        phase: 'done',
        message: `Selected ${posting.title} at ${posting.company}`,
        state: { ...run.state, selectedKey: key, gate: '' },
      },
      d,
      [makeEvent(d.now(), 'info', 'select', `Selected ${posting.title} at ${posting.company}`, 'radar')],
    );
    return { ...toStatus(next), jobText };
  }
  // Already done (re-selecting to re-open the handoff) or still running: text only.
  return { ...toStatus(run), jobText };
}

export async function cancelRadar(userId: string, runId: string, d: RadarDeps = defaultDeps): Promise<RadarStatus> {
  // The compare-and-set loses to a step committing at the same moment; re-read and try again
  // (a commit moves the step, it never makes the run terminal by itself), so a cancel is not lost.
  let run = await d.store.get(userId, runId);
  if (!run) throw new Error('That run was not found.');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (TERMINAL.includes(run.status)) return toStatus(run);
    const next = await d.store.update(
      run.id,
      { userId, step: run.step },
      {
        status: 'cancelled',
        message: 'Cancelled',
        step: run.step + 1,
        leasedUntil: null,
        events: appendEvents(run.events, [makeEvent(d.now(), 'info', run.phase, 'Cancelled', 'radar')]),
      },
    );
    if (next) return toStatus(next);
    run = (await d.store.get(userId, runId)) ?? run;
  }
  return toStatus(run);
}

export async function getRadar(userId: string, runId?: string, d: RadarDeps = defaultDeps): Promise<RadarStatus | null> {
  if (!runId) {
    const run = await activeRun(userId, d);
    return run ? toStatus(run) : null;
  }
  const run = await d.store.get(userId, runId);
  if (!run) return null;
  return toStatus((await cancelIfStale(run, d)) ?? run);
}
