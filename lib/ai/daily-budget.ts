/**
 * The per-day AI spend ceiling — REQ-5.6 / NFR-2.
 *
 * `DraftBudget` caps one generation run. That is the wrong unit for cost: nothing capped
 * how many runs a user could start, so a loop calling `/api/draft` repeatedly billed the
 * owner across all five providers without ever exceeding a single per-draft limit. The
 * table this writes to has existed since the first schema; nothing read or wrote it, so
 * the ceiling named in the design was never actually enforced.
 *
 * The counter is in Postgres rather than in memory because separate function instances
 * share nothing, and it is incremented with `SET calls = calls + n` so two concurrent
 * drafts cannot both read the same total and overwrite each other's increment.
 *
 * Spend is recorded after the fact, not reserved in advance: a draft that starts under
 * the ceiling is allowed to finish, which can overshoot by at most one run. Reserving
 * up front would mean refunding on failure, and a refund path that is ever skipped locks
 * a user out of their own account with no way to clear it.
 */

import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { aiUsageDaily } from '@/lib/db/schema';
import { BudgetExceededError, DAILY_BUDGET, type BudgetLimits, type BudgetUsage } from './budget';

/** UTC, so the window does not move with the user's timezone or the server's. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function readDailyUsage(userId: string, day = today()): Promise<BudgetUsage> {
  const [row] = await db
    .select({ calls: aiUsageDaily.calls, tokens: aiUsageDaily.tokens })
    .from(aiUsageDaily)
    .where(and(eq(aiUsageDaily.userId, userId), eq(aiUsageDaily.day, day)))
    .limit(1);

  return { calls: row?.calls ?? 0, tokens: row?.tokens ?? 0 };
}

/**
 * Throws if this user has already spent their day.
 *
 * Called before a run starts rather than before every provider call: one round trip per
 * draft is the right cost, and the per-draft budget already bounds what a single run can
 * spend after this passes.
 */
export async function assertDailyBudget(
  userId: string,
  limits: BudgetLimits = DAILY_BUDGET,
): Promise<void> {
  const usage = await readDailyUsage(userId);

  if (usage.calls >= limits.maxCalls) {
    throw new BudgetExceededError('daily', `${usage.calls}/${limits.maxCalls} calls today`);
  }
  if (usage.tokens >= limits.maxTokens) {
    throw new BudgetExceededError(
      'daily',
      `${Math.round(usage.tokens / 1000)}k/${Math.round(limits.maxTokens / 1000)}k tokens today`,
    );
  }
}

/**
 * Adds a run's spend to today's total.
 *
 * Never throws. This is called after work that has already happened, usually in a
 * `finally`, and a failure to record must not turn a successful draft into an error the
 * user sees — the consequence is an undercount, not a broken resume.
 */
export async function recordDailyUsage(
  userId: string,
  usage: BudgetUsage,
  day = today(),
): Promise<void> {
  if (usage.calls <= 0 && usage.tokens <= 0) return;

  try {
    await db
      .insert(aiUsageDaily)
      .values({ userId, day, calls: usage.calls, tokens: usage.tokens })
      .onConflictDoUpdate({
        target: [aiUsageDaily.userId, aiUsageDaily.day],
        set: {
          calls: sql`${aiUsageDaily.calls} + ${usage.calls}`,
          tokens: sql`${aiUsageDaily.tokens} + ${usage.tokens}`,
        },
      });
  } catch (err) {
    console.error('[budget] could not record daily AI usage:', err);
  }
}
