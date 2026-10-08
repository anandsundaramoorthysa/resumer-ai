/**
 * Draft endpoint — streams the pipeline as it runs (REQ-8.1).
 *
 * Server-Sent Events over the standard Node.js runtime. Streaming does not require the
 * Edge runtime on Vercel, and staying on Node keeps @react-pdf/renderer, docx, mammoth
 * and pdf-parse available — all of which need Node APIs.
 *
 * Two ways in. The browser now arrives here after a fit check (app/api/draft/assess),
 * carrying a sealed assessment: the job was already read and the profile already synced,
 * so neither is done again and the time goes to the revision loop instead. Called with a
 * job and no assessment — a script, an older client — it reads the job itself, exactly as
 * it always has.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { runDraftPipeline, newDraftRunTrace, PipelineError } from '@/lib/pipeline/run';
import { loadProfileForUser, persistDraft, buildSyncStep } from '@/lib/server/profile';
import { recordEnrichmentQuestions } from '@/lib/server/enrichment';
import { recordDraftRun } from '@/lib/server/draft-run';
import {
  claimDraftRun,
  drizzleDraftRunStore,
  markRunSnapshot,
  runningFreshMs,
  normalizeIdempotencyKey,
  replayCompletePayload,
} from '@/lib/server/draft-idempotency';
import { salvagedCompletePayload } from '@/lib/pipeline/early-persist';
import type { GeneratedDraft } from '@/lib/pipeline/run';
import { readJobSubmission, jsonError, SUBMISSION_GUARD } from '@/lib/server/job-submission';
import { guardMutation } from '@/lib/server/request-guard';
import { eventStream } from '@/lib/server/sse';
import { AssessmentTokenError, openAssessment } from '@/lib/fit/token';

import { BudgetExceededError } from '@/lib/ai/budget';
import { userMessage } from '@/lib/server/user-message';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return jsonError('Sign in first.', 401);
  const refused = guardMutation(req, SUBMISSION_GUARD);
  if (refused) return refused;

  /*
   * Idempotency. The browser sends one `Idempotency-Key` per attempt and reuses it when it
   * retries after a dropped connection (see lib/server/draft-idempotency.ts for the four
   * cases). A peek first, before the body is read: a retry whose sealed assessment has since
   * expired must still be handed the resume that already exists.
   */
  const key = normalizeIdempotencyKey(req.headers.get('idempotency-key'));
  const store = drizzleDraftRunStore();
  const replay = async (snapshotId: string): Promise<Response> => {
    const payload = await replayCompletePayload(userId, snapshotId);
    if (!payload) return jsonError('That draft is no longer available. Start a new one.', 410);
    return eventStream({ run: async ({ send }) => send('complete', payload) });
  };
  if (key) {
    const existing = await store.find(userId, key);
    if (existing?.snapshotId && (existing.status === 'success' || existing.status === 'running')) {
      return replay(existing.snapshotId);
    }
  }

  const submission = await readJobSubmission(req, userId);
  if (!submission.ok) return submission.response;
  const { jobInput, fileText, fileName, assessment } = submission;

  // Opened before anything streams, so a stale or foreign fit check is a plain refusal
  // with a sentence the browser can show, rather than an error frame mid-stream.
  let assessed: ReturnType<typeof openAssessment> | null = null;
  if (assessment) {
    try {
      assessed = openAssessment(assessment, userId);
    } catch (err) {
      if (err instanceof AssessmentTokenError) return jsonError(err.message, 400);
      throw err;
    }
  }

  /*
   * The run record, assembled alongside the stream rather than after it.
   *
   * This endpoint is the only place that sees both halves of a draft: the stage events on
   * their way to the browser, and how the attempt ended. Both used to be discarded; see
   * `draftRuns` in lib/db/schema.ts. The events and the start time come from the stream
   * (lib/server/sse.ts); what is decided here is how the attempt ended.
   */
  const trace = newDraftRunTrace();
  let snapshotId: string | null = null;
  /** Set on every path that does not finish with a resume; null means it did. */
  let failure: { error?: unknown; kind?: string } | null = null;

  // The claim IS the run row: a new key inserts it, a duplicate is answered here.
  const claim = await claimDraftRun(store, userId, key);
  if (claim.kind === 'done') return replay(claim.snapshotId);
  if (claim.kind === 'running') {
    return Response.json(
      {
        error: 'This draft is already running.',
        running: true,
        pollForMs: runningFreshMs(),
        statusUrl: `/api/draft/status?key=${encodeURIComponent(key ?? '')}`,
      },
      { status: 409 },
    );
  }
  const runId: string | null = claim.runId;
  /** Filled by the pipeline's `onGenerated` hook — present once the resume is saved. */
  const saved: { generated: GeneratedDraft | null } = { generated: null };

  return eventStream({
    run: async ({ send, emit }) => {
      try {
        const profile = await loadProfileForUser(userId);

        if (profile.records.length === 0) {
          // A refusal, not a crash — but still an attempt that produced no resume, and it
          // is recorded as one. A user whose drafts all fail this way has a profile
          // problem, and that is not visible anywhere else.
          failure = { kind: 'empty-profile' };
          send('error', {
            message:
              'Your profile is empty. Connect your GitHub portfolio or add a few skills and roles first — there is nothing to build a resume from yet.',
          });
          return;
        }

        const result = await runDraftPipeline(
          {
            userId,
            // The row this request claimed, so every AI call it makes is attributed to it exactly.
            draftRunId: runId,
            contact: profile.contact,
            records: profile.records,
            roles: profile.roles,
            jobInput,
            jobFileText: fileText || undefined,
            jobFileName: fileName || undefined,
            // The fit check synced moments ago; a second GitHub round trip finds nothing.
            syncStep: assessed ? undefined : buildSyncStep(userId),
            trace,
            job: assessed?.job,
            fit: assessed?.fit,
            // Saved the moment the gate finishes, before the render: a kill or a throw in
            // the seconds after still leaves the user their resume.
            onGenerated: async (g) => {
              saved.generated = g;
              snapshotId = await persistDraft(userId, {
                document: g.document,
                score: g.score,
                job: g.job,
                fit: g.fit,
                files: { pdf: Buffer.alloc(0), docx: Buffer.alloc(0), pdfName: g.pdfName, docxName: g.docxName },
              });
              await markRunSnapshot(runId, userId, snapshotId);
            },
          },
          emit,
        );

        // Only when the hook did not already save it (a pipeline without the hook).
        if (!snapshotId) {
          snapshotId = await persistDraft(userId, result);
          await markRunSnapshot(runId, userId, snapshotId);
        }

        /*
         * File what this draft could not evidence against the records it concerns.
         *
         * After the snapshot and inside its own try: the resume exists by this point and
         * is about to be handed to the user, and a failure to write a follow-up question
         * must not turn a finished draft into an error frame. Logged where logs are read
         * rather than surfaced, for the reason the catch below gives — nothing thrown by
         * the database was written for the person who uploaded a job description.
         */
        try {
          await recordEnrichmentQuestions(
            userId,
            result.enrichment,
            profile.records,
            profile.roles,
          );
        } catch (err) {
          console.error('[draft] could not record enrichment questions for user', userId, err);
        }

        send('complete', {
          snapshotId,
          score: result.score,
          job: result.job,
          selfTest: result.selfTest,
          budget: result.budget,
          fileNames: {
            pdf: result.files.pdfName,
            docx: result.files.docxName,
          },
          document: result.document,
          fit: result.fit,
        });
      } catch (err) {
        // The resume was saved and something after the save threw (the render, the
        // enrichment bookkeeping above is guarded separately). Tell the user the truth:
        // they have a draft. Logged for the developer; recorded as a success.
        const persisted = snapshotId as string | null;
        const generated = saved.generated;
        if (persisted && generated) {
          console.error('[draft] failed after the resume was saved, returning it for user', userId, err);
          failure = null;
          send('complete', salvagedCompletePayload(generated, persisted));
          return;
        }

        // `PipelineError` messages are written to be read by the person who uploaded
        // the job — they name the stage and what to do next, and nothing else. Every
        // other exception reaching here was written for a developer: a Drizzle or
        // postgres.js failure carries the statement, a provider error carries its own
        // response, and lib/sync/github.ts puts the whole GitHub response body into the
        // message it throws. Nothing secret travels those paths today, which is the only
        // reason this was ever survivable — one refactor away from a connection string
        // or a token fragment arriving in the browser over an SSE frame. So the generic
        // branch is logged where logs are read and answered with one sentence.
        failure = { error: err };
        // A budget refusal is an answer for the user (see the fit-check route), not a crash.
        if (!(err instanceof PipelineError) && !(err instanceof BudgetExceededError)) {
          console.error('[draft] pipeline failed for user', userId, err);
        }
        send('error', {
          message:
            err instanceof PipelineError
              ? err.message
              : userMessage(
                  err,
                  'The draft failed unexpectedly. Nothing was saved — try again, and if it keeps happening the server log has the detail.',
                ),
          kind: err instanceof PipelineError ? err.kind : 'generic',
        });
      }
    },

    /*
     * Record the attempt — before the stream closes, which lib/server/sse.ts guarantees
     * and explains. One call site: success, pipeline failure and the empty-profile refusal
     * all pass through here, so there is no path that returns a response without leaving
     * a row. Inside its own try, because a failure to write a note about a draft must
     * never turn a finished draft into an error. `errorDetail` is stored, never sent.
     */
    finish: async ({ events, startedAt }) => {
      const f = failure as { error?: unknown; kind?: string } | null;
      try {
        await recordDraftRun({
          runId,
          userId,
          startedAt,
          finishedAt: new Date(),
          events,
          trace,
          snapshotId: f ? null : snapshotId,
          error: f?.error,
          errorKind: f?.kind,
        });
      } catch (err) {
        console.error('[draft] could not record the draft run for user', userId, err);
      }
    },
  });
}
