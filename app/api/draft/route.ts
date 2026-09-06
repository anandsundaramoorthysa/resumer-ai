/**
 * Draft endpoint — streams the pipeline as it runs (REQ-8.1).
 *
 * Server-Sent Events over the standard Node.js runtime. Streaming does not require the
 * Edge runtime on Vercel, and staying on Node keeps @react-pdf/renderer, docx, mammoth
 * and pdf-parse available — all of which need Node APIs.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
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

  const body = (await req.json().catch(() => ({}))) as { jobInput?: string };
  const jobInput = (body.jobInput ?? '').trim();

  if (jobInput.length < 3) {
    return new Response(
      JSON.stringify({ error: 'Paste a job link or description to draft against.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

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
        send('error', {
          message:
            err instanceof PipelineError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Draft failed unexpectedly.',
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
