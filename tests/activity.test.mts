/**
 * The Activity page's arithmetic — lib/server/activity.ts. Silent when wrong: a success
 * rate off by a run still looks like a percentage.
 */

import { summarizeRuns, usageDays } from '../lib/server/activity';
import { suite, test, assert } from './harness.mjs';

suite('activity summary', () => {
  test('success rate and median duration', () => {
    const s = summarizeRuns([
      { status: 'success', durationMs: 40_000 },
      { status: 'failed', durationMs: 5_000 },
      { status: 'success', durationMs: 50_000 },
      { status: 'success', durationMs: 60_000 },
    ]);
    assert.deepEqual(s, { total: 4, failed: 1, successPct: 75, medianSeconds: 45 });
  });

  test('no runs is no rate, not 0%', () => {
    assert.deepEqual(summarizeRuns([]), { total: 0, failed: 0, successPct: null, medianSeconds: null });
  });

  test('usage fills quiet days with zeros, newest first', () => {
    const days = usageDays([{ day: '2026-09-10', calls: 12, tokens: 900 }], 3, new Date('2026-09-11T08:00:00Z'));
    assert.deepEqual(days.map((d) => [d.day, d.calls]), [['2026-09-11', 0], ['2026-09-10', 12], ['2026-09-09', 0]]);
  });
});
