import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { accounts, contactInfo, syncJobs, users } from '@/lib/db/schema';
import {
  fetchPortfolioFiles,
  latestCommitSha,
  parseRepoRef,
  type RepoFile,
} from './github';
import { EXTRACTION_PASSES, runPass, toRecords, mergeExtractions } from './parse';
import type { ExtractedProfile } from './parse';
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
 *   steps 1..N        one focused extraction pass each
 *   step N+1          merge, reconcile and write
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

const TOTAL_STEPS = EXTRACTION_PASSES.length + 2;

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
      totalSteps: TOTAL_STEPS,
      message: 'Checking your portfolio for changes…',
    })
    .returning();

  return {
    jobId: job.id,
    step: 0,
    totalSteps: TOTAL_STEPS,
    status: 'running',
    message: job.message,
    done: false,
  };
}

export async function advanceSyncJob(
  userId: string,
  jobId: string,
): Promise<StepResult> {
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
    return await runStep(userId, job);
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

async function runStep(userId: string, job: Job): Promise<StepResult> {
  const finish = async (patch: Partial<Job>, res: Omit<StepResult, 'jobId' | 'totalSteps'>) => {
    await db
      .update(syncJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
    return { jobId: job.id, totalSteps: job.totalSteps, ...res };
  };

  // ---------------------------------------------------------- step 0: fetch --
  if (job.step === 0) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const ref = user?.portfolioRepo ? parseRepoRef(user.portfolioRepo) : null;
    if (!ref) throw new Error('No portfolio repository connected.');

    const [account] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'github')))
      .limit(1);
    if (!account?.access_token) {
      throw new Error('No GitHub token — sign out and back in to re-grant repo access.');
    }

    const sha = await latestCommitSha(ref, account.access_token);

    // The SHA gate (NFR-7): unchanged means the whole job is already done.
    if (sha === user?.lastSyncedSha) {
      return finish(
        { status: 'done', step: job.totalSteps, message: 'Already up to date' },
        { step: job.totalSteps, status: 'done', message: 'Already up to date', done: true },
      );
    }

    const files = await fetchPortfolioFiles(ref, account.access_token, sha);
    if (files.length === 0) {
      throw new Error(
        'No readable content files found in that repository. Check the repo has your profile data in it.',
      );
    }

    return finish(
      {
        step: 1,
        sha,
        corpus: files,
        message: `Read ${files.length} files — extracting ${EXTRACTION_PASSES[0].label}…`,
      },
      {
        step: 1,
        status: 'running',
        message: `Read ${files.length} files from your portfolio`,
        done: false,
      },
    );
  }

  // ------------------------------------------- steps 1..N: extraction passes --
  const passIndex = job.step - 1;
  if (passIndex < EXTRACTION_PASSES.length) {
    const pass = EXTRACTION_PASSES[passIndex];
    const corpus = (job.corpus ?? []) as RepoFile[];

    // One pass at a time: running them concurrently hit provider rate limits and made
    // several passes fail outright, which is worse than taking a few seconds longer.
    let partial: Record<string, unknown> | null = null;
    try {
      partial = (await runPass(pass, corpus)) as Record<string, unknown>;
    } catch {
      // A failed pass loses only its own category. Skills surviving while
      // certifications fail is a far better outcome than an all-or-nothing sync.
      partial = null;
    }

    const nextStep = job.step + 1;
    const nextLabel =
      passIndex + 1 < EXTRACTION_PASSES.length
        ? EXTRACTION_PASSES[passIndex + 1].label
        : 'saving';

    return finish(
      {
        step: nextStep,
        partials: [...(job.partials ?? []), ...(partial ? [partial] : [])],
        message: `Extracted ${pass.label} — next: ${nextLabel}…`,
      },
      {
        step: nextStep,
        status: 'running',
        message: partial
          ? `Extracted ${pass.label}`
          : `Couldn't read ${pass.label} — continuing with the rest`,
        done: false,
      },
    );
  }

  // --------------------------------------------- final step: merge and write --
  const merged = mergeExtractions((job.partials ?? []) as ExtractedProfile[]);
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
    { status: 'done', step: job.totalSteps, message: summary, corpus: null },
    { step: job.totalSteps, status: 'done', message: summary, done: true },
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
