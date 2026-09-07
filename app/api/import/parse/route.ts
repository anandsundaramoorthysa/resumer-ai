/**
 * Extraction step of the old-resume importer — task 2.2.
 *
 * One chunk, one AI call, one short request. The client posts chunks in sequence and
 * shows real progress, which is the same arrangement the portfolio sync uses
 * (lib/sync/stepped.ts) and for the same reason: no serverless host will hold a request
 * open for the whole job, and racing the limit is a worse answer than not needing it.
 *
 * Batching two chunks per request would halve the round trips and double the worst-case
 * request length — the wrong trade on a host whose non-streaming functions stop at 10s.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { BudgetExceededError, DraftBudget } from '@/lib/ai/budget';
import { assertDailyBudget, recordDailyUsage } from '@/lib/ai/daily-budget';
import { MAX_CHUNK_CHARS } from '@/lib/import/text';
import { extractFromChunk } from '@/lib/import/parse';

export const runtime = 'nodejs';
export const maxDuration = 60;

const BodySchema = z.object({ chunk: z.string().min(1) });

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }
  const userId = session.user.id;

  // The per-request budget below caps one chunk. A file is chunked into many, and
  // nothing caps how many files — so the only real ceiling on what an import can spend
  // is the daily one, which for a long time existed in the schema and was never read.
  try {
    await assertDailyBudget(userId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return Response.json({ error: err.message }, { status: 429 });
    }
    throw err;
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Expected { chunk: string }.' }, { status: 400 });
  }

  // One call, so the circuit breaker (REQ-5.6) still applies to an import even though
  // this is not a draft run.
  const budget = new DraftBudget({ maxCalls: 1, maxTokens: 60_000 });

  try {
    const partial = await extractFromChunk(
      parsed.data.chunk.slice(0, MAX_CHUNK_CHARS * 2),
      budget,
    );
    return Response.json({ partial, read: true });
  } catch (err) {
    // One unreadable chunk costs only itself. The client counts these and says how many
    // sections it could not read, rather than reporting a clean import that wasn't.
    return Response.json({
      partial: {},
      read: false,
      reason: err instanceof Error ? err.message.slice(0, 200) : 'Extraction failed.',
    });
  } finally {
    // A chunk that failed still spent its tokens, so it still counts.
    await recordDailyUsage(userId, budget.snapshot());
  }
}
