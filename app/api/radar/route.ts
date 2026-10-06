/**
 * Job Radar, stepped like /api/sync: the client drives the loop, one short step per POST.
 * Every lib call takes the session's userId and filters on it, so another user's run is
 * indistinguishable from a missing one (404).
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { assertBurst } from '@/lib/ai/daily-budget';
import { BudgetExceededError } from '@/lib/ai/budget';
import { advanceRadar, approveQueries, cancelRadar, getRadar, selectPosting, startRadar } from '@/lib/radar/runs';
import { creditStatus } from '@/lib/serp/budget';
import { authoredMessage } from '@/lib/server/user-message';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

const runId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const query = z.union([
  z.string().max(120),
  z.object({ q: z.string().max(120), why: z.string().max(200).optional() }).strict(),
]);
const Body = z.union([
  z.object({ intel: z.boolean().optional() }).strict(),
  z.object({ runId, expectStep: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ runId, action: z.literal('approve'), queries: z.array(query).min(1).max(3) }).strict(),
  z.object({ runId, action: z.literal('select'), key: z.string().min(1).max(64) }).strict(),
  z.object({ runId, action: z.literal('cancel') }).strict(),
]);

async function userIdOrNull() {
  return (await auth())?.user?.id ?? null;
}

function fail(err: unknown) {
  if (err instanceof BudgetExceededError) return json({ error: err.message }, 429);
  const message = authoredMessage(err, 'Job Radar hit a problem. Try again in a minute.');
  if (message === 'That run was not found.') return json({ error: message }, 404);
  if (message.startsWith("You have used today's")) return json({ error: message }, 429);
  // A plain Error from lib/radar is a sentence written for the user (bad key, no queries...).
  const authored = err instanceof Error && err.constructor === Error;
  return json({ error: message }, authored ? 400 : 500);
}

export async function GET(req: NextRequest) {
  const userId = await userIdOrNull();
  if (!userId) return json({ error: 'Sign in first.' }, 401);

  const p = req.nextUrl.searchParams;
  try {
    if (p.get('credits')) return json({ ...(await creditStatus()) });
    const id = p.get('runId');
    if (id !== null && !runId.safeParse(id).success) return json({ error: 'Invalid run id.' }, 400);
    const run = await getRadar(userId, id ?? undefined);
    if (id && !run) return json({ error: 'That run was not found.' }, 404);
    return json({ run });
  } catch (err) {
    console.error('[radar] read failed for user', userId, err);
    return fail(err);
  }
}

export async function POST(req: NextRequest) {
  const userId = await userIdOrNull();
  if (!userId) return json({ error: 'Sign in first.' }, 401);

  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw ?? {});
  if (!parsed.success) return json({ error: 'That request was not valid.' }, 400);
  const b = parsed.data;

  try {
    await assertBurst(userId);
    if (!('runId' in b)) return json(await startRadar(userId, { intel: b.intel }));
    if ('expectStep' in b) return json(await advanceRadar(userId, b.runId, b.expectStep));
    if (b.action === 'approve') return json(await approveQueries(userId, b.runId, b.queries));
    if (b.action === 'select') return json(await selectPosting(userId, b.runId, b.key));
    return json(await cancelRadar(userId, b.runId));
  } catch (err) {
    console.error('[radar] request failed for user', userId, err);
    return fail(err);
  }
}
