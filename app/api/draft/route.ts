/**
 * Draft endpoint — streams the pipeline as it runs (REQ-8.1).
 *
 * Server-Sent Events over the standard Node.js runtime. Streaming does not require the
 * Edge runtime on Vercel, and staying on Node keeps @react-pdf/renderer, docx, mammoth
 * and pdf-parse available — all of which need Node APIs.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import {
  MAX_UPLOAD_BYTES,
  UnsafeUploadError,
  extractUploadText,
  formatFromFile,
} from '@/lib/import/text';
import {
  fileRejection,
  hasReadableText,
  unreadableFileMessage,
  validateJobSubmission,
  type JobInputRejection,
} from '@/lib/intake/job-input';
import { runDraftPipeline, PipelineError } from '@/lib/pipeline/run';
import { loadProfileForUser, persistDraft, buildSyncStep } from '@/lib/server/profile';
import type { PipelineEvent } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return new Response(JSON.stringify({ error: 'Sign in first.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Two transports, one endpoint. A file can only arrive as multipart, but everything
  // that already posts JSON here keeps working untouched — the branch is on what the
  // request actually says it is, not on a new route.
  const isMultipart = (req.headers.get('content-type') ?? '')
    .toLowerCase()
    .includes('multipart/form-data');

  let jobInput = '';
  let fileText = '';
  let fileName = '';

  if (isMultipart) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return reject({
        problem: 'empty',
        message: 'That upload could not be read. Try attaching the file again.',
        status: 400,
      });
    }

    const typed = form.get('jobInput');
    jobInput = typeof typed === 'string' ? typed.trim() : '';

    const file = form.get('jobFile');
    if (file instanceof File && file.size > 0) {
      // The browser's declared type is a hint, never the decision: the extension and
      // the MIME type are both checked here, and the size cap is re-enforced on this
      // side because the input's `accept` attribute stops nothing that is not a browser.
      if (file.size > MAX_UPLOAD_BYTES) {
        return reject(
          fileRejection('file-too-big', {
            sizeBytes: file.size,
            maxBytes: MAX_UPLOAD_BYTES,
          }),
        );
      }

      const format = formatFromFile(file.name, file.type);
      if (!format) return reject(fileRejection('file-type'));

      try {
        // Read into memory, use the text, let the bytes go. Nothing is written to disk
        // or to any store, exactly as the importer promises for the same file types.
        const buffer = Buffer.from(await file.arrayBuffer());
        const extracted = await extractUploadText(buffer, format);
        if (!hasReadableText(extracted.text)) {
          return reject(unreadableFileMessage(format));
        }
        fileText = extracted.text;
        fileName = file.name;
      } catch (err) {
        // Same rule as the SSE error below, for the same reason. `UnsafeUploadError`
        // messages are written for the person who chose the file — "that DOCX expands
        // to far more than a document should" tells them what to do next. Anything else
        // here is a library's internals: mammoth and pdf-parse describe their own
        // structures, and a decompression guard is exactly the surface where an
        // attacker probes with malformed input to see what the parser says back.
        if (!(err instanceof UnsafeUploadError)) {
          console.error('[draft] job file could not be read for user', userId, err);
        }
        return reject({
          problem: 'file-unreadable',
          message:
            err instanceof UnsafeUploadError
              ? `Could not read that file: ${err.message}`
              : 'That file could not be read. If it is a PDF, make sure it is not a scan; otherwise try a DOCX, or paste the text instead.',
          status: 422,
        });
      }
    } else if (file instanceof File) {
      return reject(fileRejection('file-empty'));
    }
  } else {
    const body = (await req.json().catch(() => ({}))) as { jobInput?: string };
    jobInput = (body.jobInput ?? '').trim();
  }

  const rejection = validateJobSubmission(jobInput, fileText.length);
  if (rejection) return reject(rejection);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const emit = (e: Omit<PipelineEvent, 'at'>) =>
        send('stage', { ...e, at: Date.now() });

      try {
        const profile = await loadProfileForUser(userId);

        if (profile.records.length === 0) {
          send('error', {
            message:
              'Your profile is empty. Connect your GitHub portfolio or add a few skills and roles first — there is nothing to build a resume from yet.',
          });
          controller.close();
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
            syncStep: buildSyncStep(userId),
          },
          emit,
        );

        const snapshotId = await persistDraft(userId, result);

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
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function reject(rejection: JobInputRejection): Response {
  return new Response(JSON.stringify({ error: rejection.message }), {
    status: rejection.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
