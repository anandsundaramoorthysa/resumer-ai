/**
 * One improvement pass on a saved resume — called by the browser, repeatedly, after a
 * draft that stopped short of the bar with room left to improve.
 *
 * Each call is its own short request, which is the whole point: Netlify's free tier kills
 * a function at 30 seconds, a draft has room for one revision pass inside that, and the
 * quality loop was designed for four. Rather than ask for more time, the loop saves where
 * it got to and this route resumes it (lib/pipeline/improve.ts). The resume is improved in
 * place, and only when a pass produces a version that scores higher and still renders.
 *
 * Refused, rather than attempted, when there is nothing to do: the resume already passes,
 * the loop has said another pass cannot help, or the application it belongs to has moved
 * past draft — at which point the snapshot is a record of what was sent (REQ-9.2), and
 * improving it would quietly rewrite that record.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { newDraftRunTrace } from '@/lib/pipeline/run';
import { runImprovePass } from '@/lib/pipeline/improve';
import {
  loadProfileForUser,
  loadSnapshotForImprove,
  saveImprovedSnapshot,
} from '@/lib/server/profile';
import { recordDraftRun, startDraftRun } from '@/lib/server/draft-run';
import { jsonError } from '@/lib/server/job-submission';
import { guardMutation, isSafeId } from '@/lib/server/request-guard';
import { eventStream } from '@/lib/server/sse';
import { BudgetExceededError } from '@/lib/ai/budget';
import { resumeFileName } from '@/lib/render/filename';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ snapshotId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return jsonError('Sign in first.', 401);

  const refused = guardMutation(req, { contentTypes: ['application/json'], maxBytes: 4096 });
  if (refused) return refused;

  const { snapshotId } = await ctx.params;
  if (!isSafeId(snapshotId)) return jsonError('That resume was not found.', 404);
  const snap = await loadSnapshotForImprove(userId, snapshotId);
  if (!snap) return jsonError('That resume was not found.', 404);

  if (snap.applicationStatus && snap.applicationStatus !== 'draft') {
    return jsonError(
      'This resume belongs to an application that has moved past draft, so it is kept exactly as it was sent.',
      409,
    );
  }
  if (snap.result.passed) return jsonError('This resume already clears the bar.', 409);
  if (!snap.result.loop?.canContinue) {
    return jsonError('Another pass cannot improve this resume any further.', 409);
  }

  const trace = newDraftRunTrace();
  trace.job = {
    roleTitle: snap.document.jobRequirement?.roleTitle ?? '',
    company: snap.document.jobRequirement?.company ?? '',
  };
  let failure: { error?: unknown; kind?: string } | null = null;
  let runId: string | null = null;

  return eventStream({
    run: async ({ send, emit, startedAt }) => {
      runId = await startDraftRun(userId, startedAt);
      try {
        const profile = await loadProfileForUser(userId);
        const { outcome, improved } = await runImprovePass(
          {
            userId,
            document: snap.document,
            saved: snap.result,
            records: profile.records,
            trace,
          },
          emit,
        );

        await saveImprovedSnapshot(userId, snapshotId, {
          result: outcome.result,
          fit: snap.fit,
          ...(improved
            ? { document: outcome.document, fileName: resumeFileName(outcome.document, 'pdf') }
            : {}),
        });

        send('complete', { snapshotId, score: outcome.result, improved });
      } catch (err) {
        failure = { error: err };
        if (!(err instanceof BudgetExceededError)) {
          console.error('[improve] pass failed for user', userId, err);
        }
        send('error', {
          // The daily-budget message is ours and written for the user; anything else is
          // not, and gets a sentence instead.
          message:
            err instanceof BudgetExceededError
              ? err.message
              : 'This improvement pass failed. Your saved resume is unchanged — you can try again.',
        });
      }
    },
    finish: async ({ events, startedAt }) => {
      const f = failure as { error?: unknown; kind?: string } | null;
      try {
        // Every pass is a row, linked to the resume it worked on — so "how many passes
        // did this resume take, and what did each one do" has an answer.
        await recordDraftRun({
          runId,
          userId,
          startedAt,
          finishedAt: new Date(),
          events,
          trace,
          snapshotId: f ? null : snapshotId,
          error: f?.error,
          errorKind: f ? (f.kind ?? undefined) : undefined,
        });
      } catch (err) {
        console.error('[improve] could not record the pass for user', userId, err);
      }
    },
  });
}
