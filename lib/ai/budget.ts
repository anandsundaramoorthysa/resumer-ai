/**
 * Circuit breaker — REQ-5.6 / NFR-2.
 *
 * Two independent caps, both enforced regardless of whether the quality-gate score
 * has converged. A stuck loop retrying across all five providers must not be able to
 * quietly run up cost.
 *
 *  - Per-draft:  bounded calls/tokens for one resume generation run.
 *  - Per-day:    bounded calls/tokens per user across the whole app.
 *
 * The per-draft budget is an in-memory object owned by the request. The daily budget
 * is persisted, since it has to survive across requests.
 */

// Type-only, so this stays a leaf module at runtime and chain.ts can keep importing it.
import type { CallOptions } from './chain';

export class BudgetExceededError extends Error {
  constructor(
    public readonly scope: 'draft' | 'daily' | 'time',
    public readonly detail: string,
  ) {
    super(
      scope === 'time'
        ? `Ran out of time for this draft (${detail}). Stopped and kept the best version so far.`
        : scope === 'draft'
          ? `Per-draft AI budget exhausted (${detail}). Stopped before spending more.`
          : `Daily AI budget exhausted (${detail}). Stopped before spending more.`,
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * Wall-clock budget for one draft — REQ-5.6, extended.
 *
 * Serverless platforms kill a function mid-flight when it overruns, and a killed
 * function produces nothing: no resume, no explanation, just a dead connection. Ending
 * a second early with the best version we have is strictly better than being terminated
 * a second late with nothing, so the loop watches the clock as well as the spend.
 *
 * Defaults are platform-aware because the ceilings genuinely differ — and on Netlify
 * they differ by PLAN, which is the part this comment used to get wrong. It said
 * "Netlify streaming functions cap at 60s", which is true of credit-based accounts. This
 * site is on a Free plan, and its production function log shows a draft killed at
 * `Duration: 30000 ms`. With a 50s budget against a 30s ceiling, the graceful stop above
 * never once got to run: every draft in production was killed mid-call, and the account
 * that exists to use this app had no resume snapshots at all.
 *
 * Measure the ceiling from your own function logs; do not take it from the docs.
 * Vercel functions here allow 300s.
 */
function defaultTimeBudgetMs(): number {
  const override = Number(process.env.MAX_DRAFT_SECONDS);
  if (Number.isFinite(override) && override > 0) return override * 1000;

  // Netlify sets NETLIFY=true in its BUILD, but not in the function runtime — so in
  // practice MAX_DRAFT_SECONDS is what decides this there, and it must be set.
  //
  // When this branch does run, the plan is unknown, and the two ways to be wrong are not
  // equally expensive: budgeting low on a 60s plan costs a quality iteration or two,
  // while budgeting high on a 30s plan costs the entire resume. So it assumes the lower
  // ceiling — 20s, which leaves about 4s for the work done before the budget starts and a
  // margin under 30.
  if (process.env.NETLIFY) return 20_000;
  return 280_000; // 20s of headroom under Vercel's 300s maxDuration
}

export const DRAFT_TIME_BUDGET_MS = defaultTimeBudgetMs();

/**
 * Held back from the time budget for the work that still has to happen after the last
 * model call returns: rendering the PDF and the DOCX, and the ATS self-test that reads
 * both back out. Measured on this profile, that tail is 1.5-3s; 8s is a deliberately
 * generous reserve, because overshooting it means the function is killed and the user
 * gets nothing, while undershooting it costs one revision pass nobody would have noticed.
 */
export const RENDER_RESERVE_MS = Number(process.env.DRAFT_RENDER_RESERVE_MS ?? 8_000);

/**
 * The smallest deadline worth handing a call.
 *
 * Two reasons it is floored rather than allowed to reach zero. `chain.ts` reads a falsy
 * `deadlineMs` as "no deadline at all", so a computed 0 would restore exactly the
 * unbounded behaviour this accessor exists to remove; and a window under the chain's
 * MIN_ATTEMPT_MS is refused before any provider is tried, which turns "nearly out of
 * time" into "every provider failed" — a misleading error for a clock problem.
 */
const MIN_CALL_DEADLINE_MS = 1_500;

export interface BudgetLimits {
  maxCalls: number;
  maxTokens: number;
}

export const DRAFT_BUDGET: BudgetLimits = {
  maxCalls: Number(process.env.MAX_AI_CALLS_PER_DRAFT ?? 24),
  maxTokens: Number(process.env.MAX_AI_TOKENS_PER_DRAFT ?? 400_000),
};

export const DAILY_BUDGET: BudgetLimits = {
  maxCalls: Number(process.env.MAX_AI_CALLS_PER_DAY ?? 400),
  maxTokens: Number(process.env.MAX_AI_TOKENS_PER_DAY ?? 6_000_000),
};

export interface BudgetUsage {
  calls: number;
  tokens: number;
}

/** Per-draft budget tracker. One instance per generation run. */
export class DraftBudget {
  private usage: BudgetUsage = { calls: 0, tokens: 0 };
  private readonly startedAt = Date.now();

  constructor(
    private readonly limits: BudgetLimits = DRAFT_BUDGET,
    private readonly timeBudgetMs: number = DRAFT_TIME_BUDGET_MS,
    /**
     * What each call keeps back from the clock for the work that follows the last one.
     * A draft renders a PDF and a DOCX after its final model call, so it keeps the render
     * reserve. A request that renders nothing must say so, or it hands that time to no one
     * — see ASSESS_RESERVE_MS in lib/pipeline/run.ts for what that cost the fit check.
     */
    private readonly reserveMs: number = RENDER_RESERVE_MS,
  ) {}

  /** Throws before a call is made if the next call would exceed any cap. */
  assertCanSpend(): void {
    if (this.usage.calls >= this.limits.maxCalls) {
      throw new BudgetExceededError(
        'draft',
        `${this.usage.calls}/${this.limits.maxCalls} calls`,
      );
    }
    if (this.usage.tokens >= this.limits.maxTokens) {
      throw new BudgetExceededError(
        'draft',
        `${this.usage.tokens}/${this.limits.maxTokens} tokens`,
      );
    }
    if (this.elapsedMs >= this.timeBudgetMs) {
      throw new BudgetExceededError(
        'time',
        `${Math.round(this.elapsedMs / 1000)}s of ${Math.round(this.timeBudgetMs / 1000)}s`,
      );
    }
  }

  record(tokens: number): void {
    this.usage.calls += 1;
    this.usage.tokens += Math.max(0, tokens || 0);
  }

  /**
   * A provider attempt that did not produce an answer — a timeout, a 429, a response that
   * would not parse.
   *
   * It still counts. The prompt was sent and the input tokens were billed before anything
   * went wrong, so recording only successes made `maxCalls` describe the cheap half of the
   * spend: a chain that tried all five providers down both paths issued up to twenty
   * provider requests and recorded one. The counter was least accurate exactly when spend
   * was running away, which is the one moment it exists for.
   *
   * Tokens default to 0 because a failed attempt usually reports no usage at all;
   * undercounting tokens is the honest option, inventing an estimate is not.
   */
  recordFailedAttempt(tokens = 0): void {
    this.record(tokens);
  }

  snapshot(): BudgetUsage {
    return { ...this.usage };
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.timeBudgetMs - this.elapsedMs);
  }

  get remainingCalls(): number {
    return Math.max(0, this.limits.maxCalls - this.usage.calls);
  }

  /**
   * Wall clock one model call may have, keeping `reserveMs` back for the rendering that
   * follows the last one.
   *
   * Draft-path callers used to pass no deadline, so `chain.ts` gave every call `Infinity`
   * and each attempt the full 25s default: five providers times two paths is ~250s for a
   * SINGLE `generateStructured`, against a 50s budget on Netlify. `assertCanSpend()` could
   * not interrupt that, because it only runs between calls — so the function was killed
   * mid-flight and the user got a dead connection, which is the exact outcome the time
   * budget exists to prevent.
   */
  callDeadlineMs(reserveMs: number = this.reserveMs): number {
    return Math.max(MIN_CALL_DEADLINE_MS, this.remainingMs - reserveMs);
  }

  /**
   * Whether there is plausibly time for another scoring iteration.
   * An iteration is a judge call plus a revise call; 12s is a deliberately
   * conservative estimate so we stop early rather than get killed mid-write.
   */
  hasTimeForAnotherIteration(estimateMs = 12_000): boolean {
    return this.remainingMs > estimateMs;
  }
}

/**
 * The call options every draft-path model call shares.
 *
 * Two settings, both of which were missing everywhere on the draft path and present in
 * `lib/sync/parse.ts`, which had already worked out why:
 *
 *  - `deadlineMs` — what is left of the draft's clock, minus the render reserve. Without
 *    it the chain has no deadline and one call can outlive the whole request (see
 *    `callDeadlineMs`).
 *  - `maxRetriesPerProvider: 0` — the fallback chain already IS the retry. Retrying inside
 *    a provider doubles the worst case without buying a second opinion, and the provider
 *    that just timed out is the least likely of the five to answer next.
 *
 * It lives here rather than at six call sites so the arithmetic has one home; callers pass
 * only what actually differs between them, which is the temperature and the tier.
 */
export function draftCallOptions(
  budget: DraftBudget | undefined,
  extra: Omit<CallOptions, 'budget' | 'deadlineMs' | 'maxRetriesPerProvider'> = {},
): CallOptions {
  return {
    ...extra,
    budget,
    maxRetriesPerProvider: 0,
    // No budget means no clock to read — the baseline resume (REQ-6.7) runs this way.
    deadlineMs: budget?.callDeadlineMs(),
  };
}
