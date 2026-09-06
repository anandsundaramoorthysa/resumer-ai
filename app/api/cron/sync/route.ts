/**
 * Daily portfolio-freshness check — task 3.7, REQ-2.2 / NFR-7.
 *
 * What this does NOT do is run a sync. A full extraction measured 1-3 minutes
 * (lib/sync/parse.ts), which is why the real sync is stepped across many short requests
 * driven by a client; a cron has no client, so starting one here would leave a job row
 * sitting at step 1 forever and block the user's next real sync.
 *
 * So it does the cheap half only: one commit-SHA call per connected repo, and where the
 * repo has moved on, it clears the cached SHA — the same single-field invalidation the
 * push webhook performs (REQ-2.5). The next draft's pre-draft gate then reports the
 * change, and the user runs the sync with a progress bar in front of them.
 *
 * Every run is bounded by a user cap and a wall clock, so it cannot grow into the long
 * request it exists to avoid.
 */

import { NextRequest } from 'next/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { latestCommitSha, parseRepoRef } from '@/lib/sync/github';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Netlify's non-streaming functions stop at 10s; this leaves room to return a result. */
const RUN_BUDGET_MS = Number(process.env.CRON_BUDGET_MS ?? 8_000);

/** Users checked per run. Single-user today; the cap is here before it isn't. */
const MAX_USERS_PER_RUN = Number(process.env.CRON_MAX_USERS ?? 25);

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header =
    req.headers.get('x-cron-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  return header === secret;
}

export async function POST(req: NextRequest) {
  return run(req);
}

/** Netlify's scheduler issues a POST; GET is here so the wiring can be checked by hand. */
export async function GET(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json(
      { error: 'CRON_SECRET is not set, so the scheduled check is disabled.' },
      { status: 501 },
    );
  }
  if (!authorized(req)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const startedAt = Date.now();
  const candidates = await db
    .select({
      id: users.id,
      portfolioRepo: users.portfolioRepo,
      lastSyncedSha: users.lastSyncedSha,
    })
    .from(users)
    .where(isNotNull(users.portfolioRepo))
    .limit(MAX_USERS_PER_RUN);

  let checked = 0;
  let invalidated = 0;
  let skipped = 0;
  const errors: string[] = [];
  let stoppedEarly = false;

  for (const user of candidates) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      stoppedEarly = true;
      break;
    }

    const ref = user.portfolioRepo ? parseRepoRef(user.portfolioRepo) : null;
    if (!ref) {
      skipped += 1;
      continue;
    }

    const [account] = await db
      .select({ token: accounts.access_token })
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.provider, 'github')))
      .limit(1);

    if (!account?.token) {
      skipped += 1;
      continue;
    }

    try {
      const sha = await latestCommitSha(ref, account.token);
      checked += 1;
      if (sha === user.lastSyncedSha) continue;

      // One field. The next draft's gate does the noticing; nothing is parsed here.
      await db.update(users).set({ lastSyncedSha: null }).where(eq(users.id, user.id));
      invalidated += 1;
    } catch (err) {
      // One unreachable repo must not stop the others — a revoked token is a per-user
      // problem, and the run still has work to do for everyone else.
      errors.push(
        `${user.portfolioRepo}: ${err instanceof Error ? err.message.slice(0, 120) : 'failed'}`,
      );
    }
  }

  return Response.json({
    ok: true,
    checked,
    invalidated,
    skipped,
    stoppedEarly,
    errors,
    tookMs: Date.now() - startedAt,
  });
}
