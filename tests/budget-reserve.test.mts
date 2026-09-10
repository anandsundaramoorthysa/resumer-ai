/**
 * What each kind of request keeps back from its clock — lib/ai/budget.ts.
 *
 * Every model call on the draft path is given "what is left, less a reserve", and the
 * reserve exists so a draft can still render its PDF and DOCX after the last call. The fit
 * check inherited the same 5-second reserve and renders nothing: on the real EA job
 * description its model call was starved into a timeout with 5 seconds of budget unspent.
 * A budget now carries its own reserve; these pin that the draft keeps the old one and
 * that a request which renders nothing can hand the time back.
 */

import { suite, test, assert } from './harness.mjs';
import { DRAFT_BUDGET, DraftBudget, RENDER_RESERVE_MS } from '../lib/ai/budget';

const WINDOW_MS = 20_000;
/** Construction to measurement takes a few ms; this is the slack allowed for it. */
const SLACK_MS = 500;

suite('what a call may take, by kind of request', () => {
  test('a draft still keeps the render reserve back by default', () => {
    const deadline = new DraftBudget(DRAFT_BUDGET, WINDOW_MS).callDeadlineMs();
    assert.ok(deadline <= WINDOW_MS - RENDER_RESERVE_MS, `got ${deadline}`);
    assert.ok(deadline > WINDOW_MS - RENDER_RESERVE_MS - SLACK_MS, `got ${deadline}`);
  });

  test('a request that renders nothing keeps back only what it names', () => {
    const deadline = new DraftBudget(DRAFT_BUDGET, WINDOW_MS, 1_500).callDeadlineMs();
    assert.ok(deadline <= WINDOW_MS - 1_500, `got ${deadline}`);
    assert.ok(deadline > WINDOW_MS - 1_500 - SLACK_MS, `got ${deadline}`);
  });

  test('which is more time than a draft gets, by exactly the difference', () => {
    const draft = new DraftBudget(DRAFT_BUDGET, WINDOW_MS).callDeadlineMs();
    const assess = new DraftBudget(DRAFT_BUDGET, WINDOW_MS, 1_500).callDeadlineMs();
    assert.ok(assess - draft >= RENDER_RESERVE_MS - 1_500 - SLACK_MS);
  });

  test('a reserve passed to the call still overrides the budget’s own', () => {
    const deadline = new DraftBudget(DRAFT_BUDGET, WINDOW_MS, 1_500).callDeadlineMs(10_000);
    assert.ok(deadline <= WINDOW_MS - 10_000, `got ${deadline}`);
  });
});
