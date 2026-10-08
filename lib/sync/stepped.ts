import { getRepoAccess } from '@/lib/server/repo-access';
import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { syncJobs, users } from '@/lib/db/schema';
import { writeContact } from '@/lib/import/commit';
import { authoredMessage } from '@/lib/server/user-message';
import {
  fetchPortfolioCorpus,
  GithubRateLimitError,
  latestCommitSha,
  parseRepoRef,
} from './github';
import { drizzleJobStore, guardedStep, jobResult } from './guards';
import type { Job, StepResult, StepWork } from './guards';
import { judgePass, mark, splitPartials } from './partial';
import type { PartialMark } from './partial';
import {
  extractFromSlice,
  mergeExtractions,
  planSlices,
  sliceLabel,
  splitSlice,
  toRecords,
} from './parse';
import type { ExtractedProfile, WorkSlice } from './parse';
import { applyParsedProfile } from '@/lib/server/profile';
import { DraftBudget } from '@/lib/ai/budget';
import { assertDailyBudget, recordDailyUsage } from '@/lib/ai/daily-budget';

/**
 * Portfolio sync, executed one short step per request.
 *
 * Measured, the extraction takes 1-3 minutes end to end — longer than any serverless
 * function will run. Splitting it into steps that each fit comfortably in a single
 * request removes the time pressure entirely rather than racing a limit, and has two
 * side benefits: real progress can be shown, and a refresh mid-sync resumes instead of
 * starting over.
 *
 *   step 0            fetch the repo (SHA gate + file download)
 *   steps 1..N        one extraction pass over one slice of the corpus
 *   step N+1          merge, reconcile and write
 *
 * Every step is bounded by STEP_BUDGET_MS rather than by hope: the extraction is given
 * an explicit deadline and the provider chain honours it. A slice that runs out of time
 * is not lost — it goes back on the queue and is retried a step later, by which point
 * the provider that stalled is on cooldown and a healthy one takes it.
 */

export type { StepResult };

const store = drizzleJobStore(db);

/** Provisional; the real count is set once we know how many slices there are. */
const INITIAL_TOTAL_STEPS = 8;

/**
 * Wall clock one step may take, end to end.
 *
 * Sized against the tightest host in play: Netlify caps a non-streaming function at
 * 10s. Staying under that is the entire reason this job is stepped, so the budget is
 * enforced here rather than assumed.
 */
const STEP_BUDGET_MS = Number(process.env.SYNC_STEP_BUDGET_MS ?? 8_500);

/** Held back from the budget so the step can always record its own progress. */
const WRITE_RESERVE_MS = 1_200;

/** Longest any single provider attempt may run inside a step. */
const ATTEMPT_TIMEOUT_MS = Number(process.env.SYNC_ATTEMPT_TIMEOUT_MS ?? 5_500);

/**
 * The sync runs on the cheap tier, and not only to save money.
 *
 * Measured on real 3.5k slices of this portfolio, per extraction:
 *   Gemini flash-lite (fast)      1.1-4.0s   reliable
 *   Groq gpt-oss-120b (standard)  1.5-5.8s   reliable
 *   Groq gpt-oss-20b (fast)       0.1-2.6s   intermittent schema rejections
 *   Fireworks (either tier)       3.1-30s    too slow for a 10s step
 *
 * Fact counts came out level between the tiers on the same slices (39 vs 38, 37 vs 33),
 * so the standard tier was buying latency rather than better extraction. It also buys
 * a specific failure here: this account's Gemini standard quota is exhausted while
 * flash-lite still answers, and the fast tier is what reaches it.
 */
const EXTRACTION_TIER = 'fast' as const;

/**
 * How many times a slice may be attempted before the job gives up on it.
 *
 * Each retry is half the size of the attempt that failed, so three attempts take a
 * slice down to a quarter of its original length — past the point where running out of
 * time is about the content rather than the provider.
 */
const MAX_SLICE_ATTEMPTS = 3;

/**
 * What one slice's extraction may spend — REQ-5.6.
 *
 * A slice is one logical call, so one recorded success is the ceiling; the allowance is
 * larger than that because the chain now counts failed attempts too (they were billed),
 * and a slice that reaches its fifth provider should still be allowed to finish rather
 * than be cut off by its own accounting. What this budget is really for is the daily
 * counter it feeds: `assertDailyBudget` cannot enforce anything it is never told about.
 *
 * The size of the hole this closes: `lib/sync/github.ts` caps the corpus at 40 files of
 * 120KB, sliced at 3,500 chars — up to ~1,370 model calls for one job, times three via
 * MAX_SLICE_ATTEMPTS — and a job is re-runnable by disconnecting the repo and connecting
 * it again. None of it was asserted against a ceiling or recorded against one.
 */
const SLICE_BUDGET = { maxCalls: 6, maxTokens: 80_000 } as const;

export async function startSyncJob(userId: string): Promise<StepResult> {
  // Reuse an in-flight job rather than starting a second one.
  const [existing] = await db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.userId, userId), eq(syncJobs.status, 'running')))
    .orderBy(desc(syncJobs.createdAt))
    .limit(1);

  if (existing) {
    return {
      jobId: existing.id,
      step: existing.step,
      totalSteps: existing.totalSteps,
      status: 'running',
      message: existing.message,
      done: false,
    };
  }

  const [job] = await db
    .insert(syncJobs)
    .values({
      userId,
      status: 'running',
      step: 0,
      totalSteps: INITIAL_TOTAL_STEPS,
      message: 'Checking your portfolio for changes…',
    })
    .returning();

  return {
    jobId: job.id,
    step: 0,
    totalSteps: INITIAL_TOTAL_STEPS,
    status: 'running',
    message: job.message,
    done: false,
  };
}

export async function advanceSyncJob(
  userId: string,
  jobId: string,
): Promise<StepResult> {
  // The clock starts before the job row is read, because that read is part of the
  // step's cost and the budget has to cover the whole request, not just the AI call.
  const deadlineAt = Date.now() + STEP_BUDGET_MS;

  // Claim, run, write only if still at the step that was read — see lib/sync/guards.ts. A
  // second tab (or a double click) that loses the claim runs nothing and spends nothing.
  return guardedStep(
    store,
    userId,
    jobId,
    (job) => runStep(userId, job, deadlineAt),
    (err) => {
      // Stored on the job and shown on the settings page, so it must be a sentence: a
      // database error here used to put "Failed query: update …" in front of the user.
      console.error('[sync] step failed for user', userId, err);
      return authoredMessage(err, 'The sync stopped on our side. Try again in a minute.').slice(0, 400);
    },
  );
}

/** A rate limit is a sentence of ours; the error class itself would be replaced by the fallback. */
function plainRateLimit(err: unknown): never {
  if (err instanceof GithubRateLimitError) throw new Error(err.message);
  throw err;
}

async function runStep(
  userId: string,
  job: Job,
  deadlineAt: number,
): Promise<StepWork> {
  const finish = async (
    patch: Partial<Job>,
    res: Omit<StepResult, 'jobId' | 'totalSteps'>,
  ): Promise<StepWork> => ({ patch, result: res });

  // ---------------------------------------------------------- step 0: fetch --
  if (job.step === 0) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const ref = user?.portfolioRepo ? parseRepoRef(user.portfolioRepo) : null;
    if (!ref) throw new Error('No portfolio repository connected.');

    const access = await getRepoAccess(userId, { owner: ref.owner, name: ref.repo });
    if (!access) {
      throw new Error(
        'No read access to that repository. Install the GitHub App on it from Settings, or sign out and back in.',
      );
    }
    const token = access.token;

    const sha = await latestCommitSha(ref, token).catch(plainRateLimit);

    // The SHA gate (NFR-7): unchanged means the whole job is already done. The SHA is only
    // ever stored after a complete pass (see the final step), so "unchanged" really does
    // mean everything was read.
    if (sha === user?.lastSyncedSha) {
      return finish(
        { status: 'done', step: job.totalSteps, message: 'Already up to date' },
        { step: job.totalSteps, status: 'done', message: 'Already up to date', done: true },
      );
    }

    const corpus = await fetchPortfolioCorpus(ref, token, sha).catch(plainRateLimit);
    const files = corpus.files;
    if (files.length === 0) {
      // Rate limits throw before this; a read that failed for any other reason is not an
      // empty repository either.
      if (corpus.incomplete.length > 0) {
        throw new Error(`${corpus.incomplete[0]}. Nothing was changed — try again.`);
      }
      throw new Error(
        'No readable content files found in that repository. Check the repo has your profile data in it.',
      );
    }

    const slices = planSlices(files);
    if (slices.length === 0) {
      throw new Error(
        'The content files in that repository are all empty. Check the repo has your profile data in it.',
      );
    }

    return finish(
      {
        step: 1,
        sha,
        corpus: slices,
        // What step 0 could not read rides along with the output, so the final step knows
        // the pass is partial. See lib/sync/partial.ts.
        partials: [
          ...corpus.incomplete.map((n) => mark('incomplete', n)),
          ...corpus.unread.map((n) => mark('unread', n)),
        ] as unknown as Job['partials'],
        totalSteps: slices.length + 2,
        message: `Read ${files.length} files — reading ${sliceLabel(slices[0])}…`,
      },
      {
        step: 1,
        status: 'running',
        message: `Read ${files.length} files from your portfolio`,
        done: false,
      },
    );
  }

  // ---------------------------------------------- steps 1..N: one slice each --
  const queue = (job.corpus ?? []) as WorkSlice[];
  const index = job.step - 1;

  if (index < queue.length) {
    const slice = queue[index];
    const label = sliceLabel(slice);
    const attempt = slice.attempt ?? 0;

    // The daily ceiling, checked before every step that can spend it.
    //
    // Deliberately here and not at the top of `runStep`: step 0 is a GitHub fetch and the
    // final step is a database write, and refusing either would throw away work already
    // paid for without preventing a single model call. This is the only step that spends.
    //
    // Thrown rather than reported softly. The catch in `advanceSyncJob` marks the job
    // failed with this message, which is what should happen — a job that cannot make
    // progress today should say so and stop, not sit at 'running' while a client polls it.
    await assertDailyBudget(userId, undefined, 'sync');

    // Per-slice, so the circuit breaker applies to a sync the same way it applies to an
    // import, and so there is a usage figure to record at all. This whole path used to
    // pass no budget: nothing capped it, and nothing counted it either.
    const budget = new DraftBudget(SLICE_BUDGET);
    budget.userId = userId;

    let partial: Record<string, unknown> | null = null;
    let failure: string | null = null;
    try {
      partial = (await extractFromSlice(slice, {
        budget,
        tier: EXTRACTION_TIER,
        deadlineMs: Math.max(0, deadlineAt - WRITE_RESERVE_MS - Date.now()),
        timeoutMs: ATTEMPT_TIMEOUT_MS,
      })) as Record<string, unknown>;
    } catch (err) {
      // One unreadable slice costs only itself. Losing a single module is far better
      // than failing a sync that has already read nine others correctly.
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      // A slice that timed out still sent its prompt, so it still counts. Recording only
      // the slices that succeeded would undercount exactly the runs worth capping.
      await recordDailyUsage(userId, budget.snapshot());
    }

    // Re-queue rather than discard, and re-queue smaller. The chain has benched
    // whichever provider just ran out of time, so the retry lands on a different one —
    // and halving the content means it is a smaller question when it gets there.
    const requeue = failure !== null && attempt + 1 < MAX_SLICE_ATTEMPTS;
    const retries = requeue
      ? splitSlice(slice).map((part) => ({ ...part, attempt: attempt + 1 }))
      : [];
    const nextQueue = retries.length > 0 ? [...queue, ...retries] : queue;

    const nextStep = job.step + 1;
    const next = nextQueue[index + 1];

    // A slice that has used every attempt is NOT read. Recorded, so the final step does
    // not read its absence as "this was removed from the portfolio".
    const skippedMark: PartialMark[] = failure !== null && !requeue ? [mark('skipped', label)] : [];

    return finish(
      {
        step: nextStep,
        corpus: retries.length > 0 ? nextQueue : undefined,
        totalSteps: nextQueue.length + 2,
        partials: [
          ...(job.partials ?? []),
          ...(partial ? [partial] : []),
          ...skippedMark,
        ] as unknown as Job['partials'],
        message: next ? `Read ${label} — next: ${sliceLabel(next)}…` : 'Saving…',
      },
      {
        step: nextStep,
        status: 'running',
        message: failure
          ? requeue
            ? `${label} timed out — will retry`
            : `Skipped ${label}`
          : `Read ${label}`,
        done: false,
      },
    );
  }

  // --------------------------------------------- final step: merge and write --
  const totalSteps = queue.length + 2;
  const { extractions, ...tally } = splitPartials<Partial<ExtractedProfile>>(
    (job.partials ?? []) as Array<Partial<ExtractedProfile> | PartialMark>,
  );
  const verdict = judgePass(tally);
  const merged = mergeExtractions(extractions);
  const parsed = toRecords(merged);

  // Only a complete pass may flag what it did not find, or remember the commit as done.
  const applied = await applyParsedProfile(userId, parsed, job.sha ?? null, {
    flagMissing: verdict.flagMissing,
    storeSha: verdict.storeSha,
  });
  const summary = verdict.notice
    ? applied === 'Already up to date'
      ? verdict.notice
      : `${verdict.notice}. ${applied}`
    : applied;

  // Fills gaps only. This was an upsert of whatever the model read, which blanked a stored
  // name whenever the portfolio did not state one and bypassed the review queue entirely.
  await writeContact(userId, parsed.contact, 'github-sync');

  return finish(
    { status: 'done', step: totalSteps, totalSteps, message: summary, corpus: null },
    { step: totalSteps, status: 'done', message: summary, done: true },
  );
}

export async function getSyncJob(
  userId: string,
  jobId: string,
): Promise<StepResult | null> {
  const job = await store.get(userId, jobId);
  return job ? jobResult(job) : null;
}
