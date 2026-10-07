/**
 * The compare-and-set guards behind the stepped sync and the flag writes.
 *
 * Kept free of `server-only` and of the app's `db` singleton, taking the Drizzle client as
 * an argument like lib/radar/runs.ts does, so the same SQL runs against the real database,
 * against an in-memory model in tests/sync-step-guard.test.mts, and against PGlite in
 * scripts/verify-sync-db.mts.
 *
 * ## Why the step needs a guard
 *
 * `advanceSyncJob` used to read the job, run the slice and write the result back with
 * nothing in between. Two tabs (or one double-click) that both read step N both ran the
 * slice — two model calls billed for one — and the second write overwrote the first's
 * partials. Now:
 *
 *   claim    `UPDATE … WHERE id AND user AND step = N AND status = 'running' AND no live
 *            lease RETURNING` — exactly one caller wins the right to run step N
 *   advance  `UPDATE … WHERE id AND user AND step = N AND status = 'running' RETURNING`
 *            — the write only lands if the job is still at the step it was read at
 *
 * A request that loses either one is stale: it does no work and gets the job's current
 * status back unchanged.
 *
 * The lease is stored in `sync_job.error` while the job is running (`lease:<expiry ms>`),
 * because that column is otherwise null until the job fails and the schema is not ours to
 * change here. Every write that moves the job on clears it, and readers hide it unless
 * the job has failed (`visibleError`). A crashed step therefore blocks a retry only for
 * `LEASE_MS`, not forever.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { profileRecords, syncJobs } from '../db/schema';

type Db = typeof import('../db').db;
export type Job = typeof syncJobs.$inferSelect;

export interface StepResult {
  jobId: string;
  step: number;
  totalSteps: number;
  status: 'running' | 'done' | 'error';
  message: string;
  done: boolean;
  error?: string;
  /** True when this request lost a race: nothing ran, this is the job as it now stands. */
  stale?: boolean;
}

/** Longer than a step can legitimately run (8.5s budget), shorter than a human gives up. */
export const LEASE_MS = 40_000;
const LEASE_PREFIX = 'lease:';

export const leaseValue = (nowMs: number) => `${LEASE_PREFIX}${nowMs + LEASE_MS}`;

/** The error to show: a lease marker is bookkeeping, not an error. */
export function visibleError(job: Pick<Job, 'status' | 'error'>): string | undefined {
  if (job.status === 'running') return undefined;
  if (!job.error || job.error.startsWith(LEASE_PREFIX)) return undefined;
  return job.error;
}

export function leaseLive(error: string | null, nowMs: number): boolean {
  if (!error || !error.startsWith(LEASE_PREFIX)) return false;
  const until = Number(error.slice(LEASE_PREFIX.length));
  return Number.isFinite(until) && until > nowMs;
}

export interface JobStore {
  get(userId: string, jobId: string): Promise<Job | null>;
  /** Wins the right to run `step`. At most one concurrent caller gets true. */
  claim(userId: string, jobId: string, step: number, nowMs: number): Promise<boolean>;
  /** Applies `patch` only if the job is still running at `fromStep`. */
  advance(userId: string, jobId: string, fromStep: number, patch: Partial<Job>): Promise<boolean>;
}

export function drizzleJobStore(db: Db): JobStore {
  return {
    async get(userId, jobId) {
      const [job] = await db
        .select()
        .from(syncJobs)
        .where(and(eq(syncJobs.id, jobId), eq(syncJobs.userId, userId)))
        .limit(1);
      return job ?? null;
    },

    async claim(userId, jobId, step, nowMs) {
      const won = await db
        .update(syncJobs)
        .set({ error: leaseValue(nowMs) })
        .where(
          and(
            eq(syncJobs.id, jobId),
            eq(syncJobs.userId, userId),
            eq(syncJobs.step, step),
            eq(syncJobs.status, 'running'),
            or(
              isNull(syncJobs.error),
              sql`${syncJobs.error} not like 'lease:%'`,
              // CASE, not a bare cast: SQL does not promise to skip the cast for a marker
              // that is not a number, and a cast error would wedge the job.
              sql`case when substring(${syncJobs.error} from 7) ~ '^[0-9]+$'
                       then substring(${syncJobs.error} from 7)::bigint <= ${nowMs}
                       else true end`,
            ),
          ),
        )
        .returning({ id: syncJobs.id });
      return won.length === 1;
    },

    async advance(userId, jobId, fromStep, patch) {
      const done = await db
        .update(syncJobs)
        .set({ error: null, ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(syncJobs.id, jobId),
            eq(syncJobs.userId, userId),
            eq(syncJobs.step, fromStep),
            eq(syncJobs.status, 'running'),
          ),
        )
        .returning({ id: syncJobs.id });
      return done.length === 1;
    },
  };
}

/** The same semantics over a Map, for tests: one atomic section per call, as SQL gives. */
export function memoryJobStore(seed: Job[] = []): JobStore & { jobs: Map<string, Job> } {
  const jobs = new Map(seed.map((j) => [j.id, { ...j }]));
  const mine = (userId: string, jobId: string) => {
    const j = jobs.get(jobId);
    return j && j.userId === userId ? j : null;
  };
  return {
    jobs,
    async get(userId, jobId) {
      const j = mine(userId, jobId);
      return j ? { ...j } : null;
    },
    async claim(userId, jobId, step, nowMs) {
      const j = mine(userId, jobId);
      if (!j || j.step !== step || j.status !== 'running' || leaseLive(j.error, nowMs)) return false;
      j.error = leaseValue(nowMs);
      return true;
    },
    async advance(userId, jobId, fromStep, patch) {
      const j = mine(userId, jobId);
      if (!j || j.step !== fromStep || j.status !== 'running') return false;
      Object.assign(j, { error: null }, patch, { updatedAt: new Date() });
      return true;
    },
  };
}

export function jobResult(job: Job, over: Partial<StepResult> = {}): StepResult {
  return {
    jobId: job.id,
    step: job.step,
    totalSteps: job.totalSteps,
    status: job.status as StepResult['status'],
    message: job.message,
    done: job.status !== 'running',
    error: visibleError(job),
    ...over,
  };
}

export interface StepWork {
  /** What to store on the job. `step` is the step the job moves to. */
  patch: Partial<Job>;
  result: Omit<StepResult, 'jobId' | 'totalSteps'>;
}

/**
 * Runs one step of one job under the guards. `work` does the step's effects and returns
 * what to persist; nothing is persisted, and `work` is not called at all, unless this
 * request holds the step.
 */
export async function guardedStep(
  store: JobStore,
  userId: string,
  jobId: string,
  work: (job: Job) => Promise<StepWork>,
  describeError: (err: unknown) => string,
  nowMs: () => number = Date.now,
): Promise<StepResult> {
  const job = await store.get(userId, jobId);
  if (!job) throw new Error('Sync job not found.');
  if (job.status !== 'running') return jobResult(job);

  const stale = async (): Promise<StepResult> => {
    const current = (await store.get(userId, jobId)) ?? job;
    return jobResult(current, { stale: true });
  };

  if (!(await store.claim(userId, jobId, job.step, nowMs()))) return stale();

  try {
    const { patch, result } = await work(job);
    if (!(await store.advance(userId, jobId, job.step, patch))) return stale();
    return { jobId: job.id, totalSteps: patch.totalSteps ?? job.totalSteps, ...result };
  } catch (err) {
    const message = describeError(err);
    const wrote = await store.advance(userId, jobId, job.step, {
      status: 'error',
      error: message,
      message: 'Sync failed',
    });
    if (!wrote) return stale();
    return {
      jobId: job.id,
      step: job.step,
      totalSteps: job.totalSteps,
      status: 'error',
      message: 'Sync failed',
      done: true,
      error: message,
    };
  }
}

/* ------------------------------------------------------------- record flags -- */

/**
 * Clears the "not found" flag on rows the repository mentions again. Only a github-sync
 * row that is actually flagged: a `manual` row is the user's and is never touched, and
 * the extra predicate keeps the returned count honest.
 */
export async function unflagSeen(db: Db, userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(profileRecords)
    .set({ flaggedForRemoval: false, updatedAt: new Date() })
    .where(
      and(
        inArray(profileRecords.id, ids),
        eq(profileRecords.userId, userId),
        eq(profileRecords.source, 'github-sync'),
        eq(profileRecords.flaggedForRemoval, true),
      ),
    )
    .returning({ id: profileRecords.id });
  return rows.map((r) => r.id);
}

/** Flags approved github-sync rows as missing. Anything else is left exactly as it is. */
export async function flagMissingRows(db: Db, userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(profileRecords)
    .set({ flaggedForRemoval: true, updatedAt: new Date() })
    .where(
      and(
        inArray(profileRecords.id, ids),
        eq(profileRecords.userId, userId),
        eq(profileRecords.source, 'github-sync'),
        // Only an approved record can be flagged as missing — see reconcile().
        eq(profileRecords.reviewState, 'approved'),
      ),
    )
    .returning({ id: profileRecords.id });
  return rows.map((r) => r.id);
}
