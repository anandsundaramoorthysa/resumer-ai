/**
 * Stepped sync — REQ-2.2/2.3.
 *
 * POST with no body starts a job; POST with { jobId } advances it by exactly one step.
 * The client drives the loop, so no single request runs long enough to hit a platform
 * function limit, and progress is real rather than a spinner.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { advanceSyncJob, startSyncJob, getSyncJob } from '@/lib/sync/stepped';
import { authoredMessage } from '@/lib/server/user-message';
import { guardMutation, isSafeId, readJsonLimited } from '@/lib/server/request-guard';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 });

  const refused = guardMutation(req, { contentTypes: ['application/json'], maxBytes: 4096 });
  if (refused) return refused;
  const read = await readJsonLimited(req, 4096);
  if (!read.ok) return read.res;
  const body = (read.value && typeof read.value === 'object' ? read.value : {}) as { jobId?: string };
  if (body.jobId !== undefined && !isSafeId(body.jobId)) return Response.json({ error: 'Not found.' }, { status: 404 });

  try {
    const result = body.jobId
      ? await advanceSyncJob(userId, body.jobId)
      : await startSyncJob(userId);
    return Response.json(result);
  } catch (err) {
    console.error('[sync] request failed for user', userId, err);
    return Response.json({ error: authoredMessage(err, 'The sync could not start. Try again in a minute.') }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 });

  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return Response.json({ error: 'jobId required.' }, { status: 400 });
  if (!isSafeId(jobId)) return Response.json({ error: 'Not found.' }, { status: 404 });

  const job = await getSyncJob(userId, jobId);
  if (!job) return Response.json({ error: 'Not found.' }, { status: 404 });
  return Response.json(job);
}
