/**
 * The draft budget's arithmetic — REQ-5.6 / NFR-2.
 *
 * Two behaviours here decide whether a draft finishes or is killed mid-flight, and both
 * are pure arithmetic that can be tested without a provider:
 *
 *   1. `callDeadlineMs` — what one model call is allowed to take. Every draft-path caller
 *      used to pass nothing, so `chain.ts` gave each call `Infinity` and one
 *      `generateStructured` could run five providers x two paths x 25s.
 *   2. `recordFailedAttempt` — a failed attempt was already billed, so it counts. Without
 *      it a chain could issue twenty provider requests and record one.
 */

import { assert, report, suite, test } from './harness.mjs';
import {
  DraftBudget,
  RENDER_RESERVE_MS,
  BudgetExceededError,
  draftCallOptions,
} from '@/lib/ai/budget';

const LIMITS = { maxCalls: 4, maxTokens: 10_000 };

suite('callDeadlineMs — what one call may take', () => {
  test('is the remaining time less the render reserve', () => {
    const budget = new DraftBudget(LIMITS, 50_000);
    const deadline = budget.callDeadlineMs();

    // elapsedMs is a real clock, so allow a few ms of slack rather than an exact equality.
    const expected = 50_000 - RENDER_RESERVE_MS;
    assert.ok(
      Math.abs(deadline - expected) < 250,
      `expected ~${expected}ms, got ${deadline}ms`,
    );
  });

  test('shrinks as the draft spends its clock', () => {
    const generous = new DraftBudget(LIMITS, 50_000).callDeadlineMs();
    const tight = new DraftBudget(LIMITS, 20_000).callDeadlineMs();
    assert.ok(tight < generous, 'a smaller time budget must yield a smaller deadline');
  });

  test('an explicit reserve overrides the default', () => {
    const budget = new DraftBudget(LIMITS, 50_000);
    assert.ok(budget.callDeadlineMs(30_000) < budget.callDeadlineMs(1_000));
  });

  test('never returns zero — chain.ts would read that as "no deadline"', () => {
    // A time budget smaller than the reserve is the case that used to produce 0, and 0 is
    // exactly the value that turns a deadline back into Infinity in the chain.
    const budget = new DraftBudget(LIMITS, 1_000);
    const deadline = budget.callDeadlineMs(8_000);
    assert.ok(deadline > 0, `deadline must be positive, got ${deadline}`);
  });

  test('the floor is still large enough for the chain to try one provider', () => {
    // chain.ts refuses any window under MIN_ATTEMPT_MS (800ms) before it starts, so a
    // floor below that would report "every provider failed" for what is a clock problem.
    const budget = new DraftBudget(LIMITS, 0);
    assert.ok(budget.callDeadlineMs() >= 800);
  });

  test('a budget with time to spare gives a call more than the floor', () => {
    const budget = new DraftBudget(LIMITS, 280_000);
    assert.ok(budget.callDeadlineMs() > 100_000);
  });
});

suite('draftCallOptions — the options every draft-path call shares', () => {
  test('carries the budget and its deadline', () => {
    const budget = new DraftBudget(LIMITS, 50_000);
    const options = draftCallOptions(budget, { temperature: 0.25 });

    assert.equal(options.budget, budget);
    assert.equal(options.temperature, 0.25);
    assert.ok((options.deadlineMs ?? 0) > 0, 'a budgeted call must carry a deadline');
  });

  test('turns off in-provider retries — the fallback chain is the retry', () => {
    assert.equal(draftCallOptions(new DraftBudget(LIMITS, 50_000)).maxRetriesPerProvider, 0);
  });

  test('passes the tier through untouched', () => {
    const options = draftCallOptions(undefined, { tier: 'fast' });
    assert.equal(options.tier, 'fast');
  });

  test('no budget means no deadline — the baseline resume runs this way', () => {
    const options = draftCallOptions(undefined, { temperature: 0.1 });
    assert.equal(options.deadlineMs, undefined);
    assert.equal(options.budget, undefined);
  });
});

suite('failed attempts count against the budget', () => {
  test('a failed attempt increments the call counter', () => {
    const budget = new DraftBudget(LIMITS, 50_000);
    budget.recordFailedAttempt();
    assert.equal(budget.snapshot().calls, 1);
  });

  test('a failed attempt adds no tokens when none are known', () => {
    const budget = new DraftBudget(LIMITS, 50_000);
    budget.recordFailedAttempt();
    assert.equal(budget.snapshot().tokens, 0);
  });

  test('it records tokens when the provider did report them', () => {
    const budget = new DraftBudget(LIMITS, 50_000);
    budget.recordFailedAttempt(1_200);
    assert.equal(budget.snapshot().tokens, 1_200);
  });

  test('enough failures exhaust the budget, which successes alone would not have', () => {
    const budget = new DraftBudget(LIMITS, 50_000);
    for (let i = 0; i < LIMITS.maxCalls; i++) budget.recordFailedAttempt();

    assert.equal(budget.remainingCalls, 0);
    assert.throws(() => budget.assertCanSpend(), BudgetExceededError);
  });

  test('the time cap still fires independently of the call cap', () => {
    const budget = new DraftBudget(LIMITS, 0);
    assert.throws(() => budget.assertCanSpend(), BudgetExceededError);
  });
});

report('budget');
