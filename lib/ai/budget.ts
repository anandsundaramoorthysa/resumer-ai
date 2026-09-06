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
    public readonly scope: 'draft' | 'daily',
    public readonly detail: string,
  ) {
    super(
      scope === 'draft'
        ? `Per-draft AI budget exhausted (${detail}). Stopped before spending more.`
        : `Daily AI budget exhausted (${detail}). Stopped before spending more.`,
    );
    this.name = 'BudgetExceededError';
  }
}

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

  constructor(private readonly limits: BudgetLimits = DRAFT_BUDGET) {}

  /** Throws before a call is made if the next call would exceed the cap. */
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
  }

  record(tokens: number): void {
    this.usage.calls += 1;
    this.usage.tokens += Math.max(0, tokens || 0);
  }

  snapshot(): BudgetUsage {
    return { ...this.usage };
  }

  get remainingCalls(): number {
    return Math.max(0, this.limits.maxCalls - this.usage.calls);
  }
}
