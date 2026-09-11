/**
 * Deleting what is finished with — run hourly beside the draft alerts.
 *
 * Three tables grew without limit and one of them grew fast: a failed sync job keeps its
 * `corpus`, which is up to 40 files of repository text, plus every partial extraction. The
 * purges for sign-in attempts and expired tokens existed already and had no caller at all.
 *
 * Everything here is bounded by age, never by user, and nothing it deletes can be read by
 * the app: a finished sync job is history, and its corpus is a copy of a git repository.
 */

import 'server-only';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { syncJobs } from '@/lib/db/schema';
import { purgeOldAttempts } from '@/lib/auth/rate-limit';
import { purgeExpiredTokens } from '@/lib/auth/tokens';

export const SYNC_JOB_KEPT_DAYS = 7;

export interface HousekeepingOutcome {
  syncJobsDeleted: number;
  corpusCleared: number;
  errors: string[];
}

export async function runHousekeeping(now = new Date()): Promise<HousekeepingOutcome> {
  const errors: string[] = [];
  const guard = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      // One failed purge must not stop the others, or the alert that runs beside them.
      errors.push(`${what}: ${err instanceof Error ? err.message.slice(0, 120) : 'failed'}`);
    }
  };

  await guard('auth attempts', purgeOldAttempts);
  await guard('expired tokens', purgeExpiredTokens);

  let syncJobsDeleted = 0;
  let corpusCleared = 0;
  const cutoff = new Date(now.getTime() - SYNC_JOB_KEPT_DAYS * 86_400_000);
  await guard('old sync jobs', async () => {
    const gone = await db
      .delete(syncJobs)
      .where(and(lt(syncJobs.updatedAt, cutoff), sql`${syncJobs.status} <> 'running'`))
      .returning({ id: syncJobs.id });
    syncJobsDeleted = gone.length;
  });
  await guard('failed job corpus', async () => {
    const cleared = await db
      .update(syncJobs)
      .set({ corpus: sql`null`, partials: [] })
      .where(and(eq(syncJobs.status, 'error'), sql`${syncJobs.corpus} is not null`))
      .returning({ id: syncJobs.id });
    corpusCleared = cleared.length;
  });

  return { syncJobsDeleted, corpusCleared, errors };
}
