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
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { aiUsageDaily, users } from '@/lib/db/schema';
import { BudgetExceededError, DAILY_BUDGET, type BudgetLimits, type BudgetUsage } from './budget';
import { callerIp, rateLimit } from '@/lib/auth/rate-limit';

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
 * What everyone together may spend in a day, across every provider key.
 *
 * The per-user ceiling is 400 calls, sign-up is open and a Google account is free, so a
 * handful of accounts could exhaust the shared provider quotas — or the owner's bill —
 * without any one of them passing their own limit. This is the ceiling on the whole app.
 * Both halves are overridable, because the right number depends on who is paying.
 */
export const APP_DAILY_LIMITS: BudgetLimits = {
  maxCalls: Number(process.env.APP_DAILY_MAX_CALLS ?? 2_000),
  maxTokens: Number(process.env.APP_DAILY_MAX_TOKENS ?? 20_000_000),
};

/**
 * The site owner's addresses, from OWNER_EMAILS (comma-separated). Pure, so it is tested.
 *
 * Sign-up is open, and everyone spends the same provider keys. The shared ceiling above
 * protects the bill, but on its own it would also lock the owner out for the rest of the
 * day once strangers had used it up. So the owner's accounts sit outside it: their usage
 * does not count toward the shared pool, and the pool running dry never refuses them.
 * Their own per-account limit still applies — a stuck loop is a stuck loop, whoever
 * started it.
 */
export function ownerEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.OWNER_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@')),
  );
}

/** Owner account ids, looked up by address and cached briefly per instance. */
let ownerIdCache: { at: number; ids: string[] } | null = null;
const OWNER_CACHE_MS = 5 * 60_000;

export async function ownerUserIds(): Promise<string[]> {
  if (ownerIdCache && Date.now() - ownerIdCache.at < OWNER_CACHE_MS) return ownerIdCache.ids;
  const emails = [...ownerEmails()];
  let ids: string[] = [];
  if (emails.length > 0) {
    try {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`);
      ids = rows.map((r) => r.id);
    } catch (err) {
      // Fails closed toward the shared pool: an owner not recognised is treated like
      // anyone else, which can only ever be stricter, never looser.
      console.warn('[budget] could not look up the owner accounts:', err instanceof Error ? err.message : err);
    }
  }
  ownerIdCache = { at: Date.now(), ids };
  return ids;
}

/**
 * What everyone except the owner has spent today — the shared pool. One aggregate over one
 * day's rows.
 */
export async function readAppUsage(day = today(), excludeUserIds: string[] = []): Promise<BudgetUsage> {
  const [row] = await db
    .select({
      calls: sql<number>`coalesce(sum(${aiUsageDaily.calls}), 0)::int`,
      tokens: sql<number>`coalesce(sum(${aiUsageDaily.tokens}), 0)::int`,
    })
    .from(aiUsageDaily)
    .where(
      excludeUserIds.length > 0
        ? and(eq(aiUsageDaily.day, day), notInArray(aiUsageDaily.userId, excludeUserIds))
        : eq(aiUsageDaily.day, day),
    );
  return { calls: row?.calls ?? 0, tokens: row?.tokens ?? 0 };
}

/** True while the app is inside its shared allowance; logs once it passes 80%. */
export function appBudgetState(usage: BudgetUsage, limits: BudgetLimits = APP_DAILY_LIMITS) {
  const share = Math.max(usage.calls / limits.maxCalls, usage.tokens / limits.maxTokens);
  return { share, exhausted: share >= 1, warn: share >= 0.8 };
}

/**
 * Where the owner's unlimited usage starts to look like somebody else's. A heavy day of
 * drafting and profile work is well under a hundred calls; this is ten times that.
 */
export const OWNER_ALERT_CALLS = Number(process.env.OWNER_ALERT_CALLS ?? 1_000);

/**
 * Throws if this user has already spent their day.
 *
 * Called before a run starts rather than before every provider call: one round trip per
 * draft is the right cost, and the per-draft budget already bounds what a single run can
 * spend after this passes.
 */
/** Which burst bucket a request draws on — see LIMITS in lib/auth/rate-limit.ts. */
export type AiPurpose = 'general' | 'sync';

/**
 * The burst limit alone: refuses a request that comes too fast for this account.
 *
 * Exported for the one caller that spends no AI but must still be bounded with the sync —
 * connecting a repository. Everything that spends AI reaches it through assertDailyBudget.
 */
export async function assertBurst(userId: string, purpose: AiPurpose = 'general'): Promise<void> {
  const isOwner = (await ownerUserIds()).includes(userId);
  const action =
    purpose === 'sync' ? (isOwner ? 'ai-sync-owner' : 'ai-sync') : isOwner ? 'ai-owner' : 'ai';
  const ip = await callerIp().catch(() => null);
  const burst = await rateLimit(action, userId, ip);
  if (!burst.allowed) {
    console.error('[budget] burst limit hit:', action, 'for user', userId, ip ? '(with an IP)' : '');
    throw new BudgetExceededError('rate', 'more than the limit in ten minutes');
  }
}

export async function assertDailyBudget(
  userId: string,
  limits: BudgetLimits = DAILY_BUDGET,
  /** 'sync' for the portfolio sync, which has its own, larger burst bucket. */
  purpose: AiPurpose = 'general',
): Promise<void> {
  const owners = await ownerUserIds();
  const isOwner = owners.includes(userId);

  // First, and for everyone: how fast. No quota below binds the owner, so this is what
  // stops a bot on a stolen session or a script looping a route. Four buckets — owner or
  // not, sync or everything else — in LIMITS (lib/auth/rate-limit.ts).
  await assertBurst(userId, purpose);

  // An account the owner has not approved spends nothing. This is the lock behind every
  // page's redirect to /pending (lib/server/approval.ts), for a request that skips pages.
  if (!isOwner) {
    const [account] = await db.select({ approval: users.approval }).from(users).where(eq(users.id, userId)).limit(1);
    if (account?.approval !== 'approved') {
      throw new BudgetExceededError('approval', account?.approval === 'denied' ? 'not approved' : 'pending');
    }
  }
  const [usage, app] = await Promise.all([readDailyUsage(userId), readAppUsage(today(), owners)]);

  if (isOwner) {
    // No daily quota for the owner, by their decision. What remains: the burst limit
    // above, the per-run budget every draft carries, and this — so an account that has
    // been taken over is noticed within the hour rather than at the end of the month.
    if (usage.calls >= OWNER_ALERT_CALLS) {
      console.error(`[budget] the owner account has made ${usage.calls} AI calls today — if that was not you, reset your password to sign out every session`);
    }
    return;
  }

  // The shared pool governs everyone but the owner (see `ownerEmails`).
  const state = appBudgetState(app);
  if (state.exhausted) {
    throw new BudgetExceededError(
      'daily',
      "the whole app's AI allowance for today is spent — it resets at midnight UTC",
    );
  }
  if (state.warn) {
    // Reaches the hourly alert's inbox through Sentry's console capture.
    console.error(`[budget] other users have used ${Math.round(state.share * 100)}% of today's shared AI allowance`);
  }

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
