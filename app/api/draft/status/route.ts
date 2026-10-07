/**
 * Where is the draft carrying this Idempotency-Key? — polled by the browser after a
 * "This draft is already running" reply or a dropped connection.
 *
 * Scoped by the signed-in user: a key is only ever looked up inside its owner's rows.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { draftStatus, drizzleDraftRunStore, normalizeIdempotencyKey } from '@/lib/server/draft-idempotency';
import { jsonError } from '@/lib/server/job-submission';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return jsonError('Sign in first.', 401);

  const key = normalizeIdempotencyKey(req.nextUrl.searchParams.get('key'));
  if (!key) return jsonError('A valid key is required.', 400);

  const status = await draftStatus(drizzleDraftRunStore(), userId, key);
  return Response.json(status, { headers: { 'Cache-Control': 'no-store' } });
}
