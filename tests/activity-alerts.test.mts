/**
 * The Activity page's arithmetic and the draft-failure alert — lib/server/activity.ts and
 * lib/server/draft-alerts.ts. Both are silent when wrong: a success rate off by a run still
 * looks like a percentage, and an alert window off by an hour still sends mail — about the
 * wrong hour, or twice.
 */

import { summarizeRuns, usageDays } from '../lib/server/activity';
import { composeAlert, previousHour } from '../lib/server/draft-alerts';
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

suite('draft-failure alert', () => {
  test('the window is the whole previous clock hour, whenever in the hour it runs', () => {
    const w = previousHour(new Date('2026-09-11T14:05:31Z'));
    assert.equal(w.start.toISOString(), '2026-09-11T13:00:00.000Z');
    assert.equal(w.end.toISOString(), '2026-09-11T14:00:00.000Z');
    assert.equal(previousHour(new Date('2026-09-11T14:59:59Z')).start.toISOString(), w.start.toISOString());
  });

  test('nothing failed, nothing sent', () => {
    assert.equal(composeAlert([], previousHour(new Date())), null);
  });

  test('failures are counted by cause and listed', () => {
    const w = previousHour(new Date('2026-09-11T14:05:00Z'));
    const f = (min: number, kind: string) => ({
      finishedAt: new Date(`2026-09-11T13:${String(min).padStart(2, '0')}:00Z`),
      errorKind: kind, errorDetail: 'Error: provider timed out', roleTitle: 'Data Analyst', company: 'Acme',
    });
    const alert = composeAlert([f(10, 'all-providers-failed'), f(20, 'all-providers-failed'), f(40, 'render')], w)!;
    assert.equal(alert.subject, 'Resumer AI: 3 drafts failed in the last hour');
    assert.ok(alert.text.includes('between 13:00 and 14:00 UTC on 2026-09-11'));
    assert.ok(alert.text.includes('2 × all-providers-failed'));
    assert.ok(alert.text.includes('13:40 UTC — render — Data Analyst at Acme'));
  });
});
