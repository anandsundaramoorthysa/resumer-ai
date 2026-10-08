/**
 * A DraftBudget that bills the daily counter as it goes, not only at the end.
 *
 * `runDraftPipeline` recorded daily usage in a `finally`, which never runs when the process
 * is killed (SIGKILL, OOM, a platform timeout) — so exactly the runs that burned the most
 * were free. This records the delta after every counted call. Each flush sends only what
 * has not been sent yet, and the final `flush()` in the `finally` sends the remainder, so
 * nothing is counted twice.
 *
 * `record` is synchronous (providers call it inline), so the write is fire-and-forget on a
 * promise chain: ordered, never throwing (the recorder must not), and awaited by `flush`.
 */

import { DraftBudget, type BudgetLimits, type BudgetUsage } from '../ai/budget';

export type UsageRecorder = (usage: BudgetUsage) => Promise<void>;

export class MeteredBudget extends DraftBudget {
  private sent: BudgetUsage = { calls: 0, tokens: 0 };
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly recorder: UsageRecorder,
    limits?: BudgetLimits,
    timeBudgetMs?: number,
    reserveMs?: number,
    userId?: string,
  ) {
    super(limits, timeBudgetMs, reserveMs);
    this.userId = userId;
  }

  override record(tokens: number): void {
    super.record(tokens);
    void this.flush();
  }

  /** Sends what is unsent and resolves once every earlier write has settled. */
  flush(): Promise<void> {
    const now = this.snapshot();
    const delta = { calls: now.calls - this.sent.calls, tokens: now.tokens - this.sent.tokens };
    if (delta.calls > 0 || delta.tokens > 0) {
      this.sent = now;
      this.chain = this.chain.then(() => this.recorder(delta)).catch(() => undefined);
    }
    return this.chain;
  }
}
