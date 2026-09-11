/**
 * The fit check — "is this role for you?", answered before any resume is written.
 *
 * Reads the job, compares the whole profile against it, and streams a verdict with
 * reasons (lib/fit/agent.ts). It does not draft. The verdict goes back to the browser
 * with the extracted job sealed inside a token (lib/fit/token.ts): when the fit is good
 * the browser starts the draft straight away, and when it is not the browser asks first
 * and starts it only if the answer is yes. Either way the draft request carries the
 * token, so the posting is read once.
 *
 * Nothing is stored for a fit check that works. A job someone looked at and decided
 * against is not history worth keeping, and an attached posting is promised never to be
 * stored at all. Only a failed check leaves a row — the silent failure is exactly the
 * case draft_run exists to catch.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { runAssessment, newDraftRunTrace, PipelineError } from '@/lib/pipeline/run';
import { loadProfileForUser, buildSyncStep } from '@/lib/server/profile';
import { discardDraftRun, errorKindFor, recordDraftRun, startDraftRun } from '@/lib/server/draft-run';
import { readJobSubmission, jsonError } from '@/lib/server/job-submission';
import { eventStream } from '@/lib/server/sse';
import { sealAssessment } from '@/lib/fit/token';

import { BudgetExceededError } from '@/lib/ai/budget';
import { userMessage } from '@/lib/server/user-message';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return jsonError('Sign in first.', 401);

  const submission = await readJobSubmission(req, userId);
  if (!submission.ok) return submission.response;
  const { jobInput, fileText, fileName } = submission;

  const trace = newDraftRunTrace();
  let failure: { error?: unknown; kind?: string } | null = null;
  let runId: string | null = null;

  return eventStream({
    run: async ({ send, emit, startedAt }) => {
      runId = await startDraftRun(userId, startedAt);
      try {
        const profile = await loadProfileForUser(userId);
        if (profile.records.length === 0) {
          failure = { kind: 'empty-profile' };
          send('error', {
            message:
              'Your profile is empty. Connect your GitHub portfolio or add a few skills and roles first — there is nothing to compare with this job yet.',
          });
          return;
        }

        const out = await runAssessment(
          {
            userId,
            contact: profile.contact,
            records: profile.records,
            roles: profile.roles,
            jobInput,
            jobFileText: fileText || undefined,
            jobFileName: fileName || undefined,
            syncStep: buildSyncStep(userId),
            trace,
          },
          emit,
        );

        send('assessed', { token: sealAssessment(userId, out.job, out.fit), fit: out.fit });
      } catch (err) {
        // Same rule as the draft route: a PipelineError was written for the user, and
        // anything else was written for a developer and is logged rather than streamed.
        failure = { error: err };
        // A budget refusal — the daily limit, the burst limit, an account still waiting
        // for approval — is an answer written for the user, not a crash. It used to fall
        // into the generic branch, so someone waiting for approval was told "the fit
        // check failed unexpectedly, try again", which they would, forever.
        if (!(err instanceof PipelineError) && !(err instanceof BudgetExceededError)) {
          console.error('[assess] fit check failed for user', userId, err);
        }
        send('error', {
          message:
            err instanceof PipelineError
              ? err.message
              : userMessage(err, 'The fit check failed unexpectedly. Nothing was saved — try again in a minute.'),
          kind: err instanceof PipelineError ? err.kind : 'generic',
        });
      }
    },
    finish: async ({ events, startedAt }) => {
      // A fit check that worked is not a run worth keeping; its row only existed so that a
      // check killed at the time limit would still leave one.
      if (!failure) {
        await discardDraftRun(userId, runId).catch((err) =>
          console.error('[assess] could not discard the run record for user', userId, err),
        );
        return;
      }
      const f = failure as { error?: unknown; kind?: string };
      try {
        await recordDraftRun({
          runId,
          userId,
          startedAt,
          finishedAt: new Date(),
          events,
          trace,
          snapshotId: null,
          error: f.error,
          // Prefixed, so a failed fit check and a failed draft are counted apart.
          errorKind: f.kind ?? `assess-${errorKindFor(f.error) ?? 'unknown'}`,
        });
      } catch (err) {
        console.error('[assess] could not record the failed fit check for user', userId, err);
      }
    },
  });
}
