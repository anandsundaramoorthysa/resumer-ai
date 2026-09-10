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
import { readJobSubmission, jsonError } from '@/lib/server/job-submission';
import { eventStream } from '@/lib/server/sse';
import { AssessmentTokenError, openAssessment } from '@/lib/fit/token';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return jsonError('Sign in first.', 401);

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
          },
          emit,
        );

        snapshotId = await persistDraft(userId, result);

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
        if (!(err instanceof PipelineError)) {
          console.error('[draft] pipeline failed for user', userId, err);
        }
        send('error', {
          message:
            err instanceof PipelineError
              ? err.message
              : 'The draft failed unexpectedly. Nothing was saved — try again, and if it keeps happening the server log has the detail.',
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
