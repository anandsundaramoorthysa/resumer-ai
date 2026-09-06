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
 * Defaults are platform-aware because the ceilings genuinely differ:
 *   Netlify streaming functions cap at 60s; Vercel functions here allow 300s.
 */
function defaultTimeBudgetMs(): number {
  const override = Number(process.env.MAX_DRAFT_SECONDS);
  if (Number.isFinite(override) && override > 0) return override * 1000;

  // Netlify sets NETLIFY=true in its build and function runtimes.
  if (process.env.NETLIFY) return 50_000; // 10s of headroom under their 60s cap
  return 280_000; // 20s of headroom under Vercel's 300s maxDuration
}

export const DRAFT_TIME_BUDGET_MS = defaultTimeBudgetMs();

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
   * Whether there is plausibly time for another scoring iteration.
   * An iteration is a judge call plus a revise call; 12s is a deliberately
   * conservative estimate so we stop early rather than get killed mid-write.
   */
  hasTimeForAnotherIteration(estimateMs = 12_000): boolean {
    return this.remainingMs > estimateMs;
  }
}
