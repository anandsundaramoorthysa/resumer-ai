import { getRepoAccess } from '@/lib/server/repo-access';
import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { contactInfo, syncJobs, users } from '@/lib/db/schema';
import { fetchPortfolioFiles, latestCommitSha, parseRepoRef } from './github';
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

export interface StepResult {
  jobId: string;
  step: number;
  totalSteps: number;
  status: 'running' | 'done' | 'error';
  message: string;
  done: boolean;
  error?: string;
}

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

  const [job] = await db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.id, jobId), eq(syncJobs.userId, userId)))
    .limit(1);

  if (!job) throw new Error('Sync job not found.');
  if (job.status !== 'running') {
    return {
      jobId: job.id,
      step: job.step,
      totalSteps: job.totalSteps,
      status: job.status as StepResult['status'],
      message: job.message,
      done: true,
      error: job.error ?? undefined,
    };
  }

  try {
    return await runStep(userId, job, deadlineAt);
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 400) : String(err);
    await db
      .update(syncJobs)
      .set({ status: 'error', error: message, message: 'Sync failed', updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
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

type Job = typeof syncJobs.$inferSelect;

async function runStep(
  userId: string,
  job: Job,
  deadlineAt: number,
): Promise<StepResult> {
  const finish = async (patch: Partial<Job>, res: Omit<StepResult, 'jobId' | 'totalSteps'>) => {
    await db
      .update(syncJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
    return {
      jobId: job.id,
      totalSteps: patch.totalSteps ?? job.totalSteps,
      ...res,
    };
  };

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

    const sha = await latestCommitSha(ref, token);

    // The SHA gate (NFR-7): unchanged means the whole job is already done.
    if (sha === user?.lastSyncedSha) {
      return finish(
        { status: 'done', step: job.totalSteps, message: 'Already up to date' },
        { step: job.totalSteps, status: 'done', message: 'Already up to date', done: true },
      );
    }

    const files = await fetchPortfolioFiles(ref, token, sha);
    if (files.length === 0) {
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

    let partial: Record<string, unknown> | null = null;
    let failure: string | null = null;
    try {
      partial = (await extractFromSlice(slice, {
        tier: EXTRACTION_TIER,
        deadlineMs: Math.max(0, deadlineAt - WRITE_RESERVE_MS - Date.now()),
        timeoutMs: ATTEMPT_TIMEOUT_MS,
      })) as Record<string, unknown>;
    } catch (err) {
      // One unreadable slice costs only itself. Losing a single module is far better
      // than failing a sync that has already read nine others correctly.
      failure = err instanceof Error ? err.message : String(err);
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

    return finish(
      {
        step: nextStep,
        corpus: retries.length > 0 ? nextQueue : undefined,
        totalSteps: nextQueue.length + 2,
        partials: [...(job.partials ?? []), ...(partial ? [partial] : [])],
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
  const merged = mergeExtractions(
    (job.partials ?? []) as Array<Partial<ExtractedProfile>>,
  );
  const parsed = toRecords(merged);
  const summary = await applyParsedProfile(userId, parsed, job.sha ?? null);

  if (parsed.contact) {
    await db
      .insert(contactInfo)
      .values({
        userId,
        fullName: parsed.contact.fullName ?? '',
        email: parsed.contact.email ?? '',
        phone: parsed.contact.phone || null,
        location: parsed.contact.location || null,
        portfolioUrl: parsed.contact.portfolioUrl || null,
        githubUrl: parsed.contact.githubUrl || null,
        linkedinUrl: parsed.contact.linkedinUrl || null,
      })
      .onConflictDoUpdate({
        target: contactInfo.userId,
        set: {
          fullName: parsed.contact.fullName ?? '',
          email: parsed.contact.email ?? '',
          phone: parsed.contact.phone || null,
          location: parsed.contact.location || null,
          portfolioUrl: parsed.contact.portfolioUrl || null,
          githubUrl: parsed.contact.githubUrl || null,
          linkedinUrl: parsed.contact.linkedinUrl || null,
        },
      });
  }

  return finish(
    { status: 'done', step: totalSteps, totalSteps, message: summary, corpus: null },
    { step: totalSteps, status: 'done', message: summary, done: true },
  );
}

export async function getSyncJob(
  userId: string,
  jobId: string,
): Promise<StepResult | null> {
  const [job] = await db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.id, jobId), eq(syncJobs.userId, userId)))
    .limit(1);
  if (!job) return null;
  return {
    jobId: job.id,
    step: job.step,
    totalSteps: job.totalSteps,
    status: job.status as StepResult['status'],
    message: job.message,
    done: job.status !== 'running',
    error: job.error ?? undefined,
  };
}
