/**
 * What a draft leaves behind — lib/server/draft-run.ts.
 *
 * The decisions worth pinning are the ones that are silent when wrong: a timeline whose
 * offsets are measured from the wrong origin still looks like a timeline, an error slug
 * built from the message makes every failure unique and counts nothing, and a redaction
 * that misses is only discovered by finding a password in a row.
 */

import { BudgetExceededError } from '../lib/ai/budget';
import {
  isApprovalRefusal,
  effectiveRunStatus,
  errorKindFor,
  redactErrorDetail,
  stagesFromEvents,
  MAX_ERROR_DETAIL_CHARS,
  RUNS_KEPT_PER_USER,
} from '../lib/server/draft-run';
import type { PipelineEvent } from '../lib/types';
import { suite, test, assert } from './harness.mjs';

const startedAt = new Date('2026-09-10T10:00:00.000Z');
const at = (seconds: number) => startedAt.getTime() + seconds * 1000;

const events = [
  { stage: 'sync', status: 'done', message: 'Using your saved profile.', at: at(0.4) },
  { stage: 'understand', status: 'running', message: 'Reading the job…', at: at(0.5) },
  { stage: 'understand', status: 'done', message: 'Data Analyst · 33 keywords', at: at(13.2), detail: { topKeywords: ['sql'] } },
] as unknown as PipelineEvent[];

suite('the stage timeline', () => {
  test('offsets are measured from the start of the run', () => {
    const stages = stagesFromEvents(events, startedAt);
    assert.deepEqual(
      stages.map((s) => s.elapsedMs),
      [400, 500, 13_200],
    );
  });

  test('every event is kept, in the order it was emitted', () => {
    const stages = stagesFromEvents(events, startedAt);
    assert.equal(stages.length, events.length);
    assert.deepEqual(
      stages.map((s) => `${s.stage}/${s.status}`),
      ['sync/done', 'understand/running', 'understand/done'],
    );
  });

  test('detail is dropped — it is columns of its own or a copy of the job', () => {
    const [, , last] = stagesFromEvents(events, startedAt);
    assert.ok(!('detail' in last));
  });

  test('an event that predates the origin cannot produce a negative offset', () => {
    const early = [{ stage: 'sync', status: 'running', message: 'x', at: at(-5) }] as unknown as PipelineEvent[];
    assert.equal(stagesFromEvents(early, startedAt)[0].elapsedMs, 0);
  });
});

suite('naming the failure', () => {
  test('the class becomes a slug that can be counted', () => {
    class AllProvidersFailedError extends Error {
      override name = 'AllProvidersFailedError';
    }
    assert.equal(errorKindFor(new AllProvidersFailedError('Gemini (high demand); Groq (timeout)')), 'all-providers-failed');
  });

  test('a kind the caller already knows wins', () => {
    assert.equal(errorKindFor(new Error('anything'), 'empty-profile'), 'empty-profile');
  });

  test('a run that did not fail has no kind', () => {
    assert.equal(errorKindFor(undefined), null);
  });

  test('two failures of the same cause share one slug, whatever they say', () => {
    const a = errorKindFor(new TypeError('Cannot read properties of undefined (reading "replace")'));
    const b = errorKindFor(new TypeError('DOMMatrix is not defined'));
    assert.equal(a, b);
  });
});

suite('what is safe to keep from an error', () => {
  test('a connection string is not stored', () => {
    const detail = redactErrorDetail(
      new Error('write CONNECTION postgres://neondb_owner:npg_TOPSECRET@ep-x.aws.neon.tech/neondb failed'),
    );
    assert.ok(detail && !detail.includes('npg_TOPSECRET'), 'the password must not survive');
    assert.ok(detail!.includes('***:***@'), 'and it should be visible that something was removed');
  });

  test('tokens in a response body are not stored', () => {
    const detail = redactErrorDetail(new Error('GitHub 401: {"access_token":"ghs_abcdef123456","x":1}'))!;
    assert.ok(!detail.includes('ghs_abcdef123456'));
    const bearer = redactErrorDetail(new Error('Authorization: Bearer sk-live-0123456789abcdef'))!;
    assert.ok(!bearer.includes('sk-live-0123456789abcdef'));
  });

  test('an ordinary message survives intact — this is the developer’s only copy', () => {
    const detail = redactErrorDetail(new Error('Setting up fake worker failed: Cannot find module pdf.worker.mjs'));
    assert.equal(detail, 'Error: Setting up fake worker failed: Cannot find module pdf.worker.mjs');
  });

  test('a very long message is truncated, and says so', () => {
    const detail = redactErrorDetail(new Error('x'.repeat(MAX_ERROR_DETAIL_CHARS * 2)))!;
    assert.ok(detail.length <= MAX_ERROR_DETAIL_CHARS + 20);
    assert.match(detail, /truncated/);
  });

  test('something thrown that is not an Error is still recorded', () => {
    assert.equal(redactErrorDetail('a bare string'), 'a bare string');
    assert.equal(redactErrorDetail(undefined), null);
  });
});

suite('history is bounded', () => {
  test('the cap is a sane number of runs', () => {
    // Small enough that a free tier never notices, large enough to cover any question
    // anyone asks of it. A guard against a future edit that sets it to 5 or 5,000.
    assert.ok(RUNS_KEPT_PER_USER >= 20 && RUNS_KEPT_PER_USER <= 200);
  });
});

suite('a run the platform killed', () => {
  const now = new Date('2026-09-11T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  test('still running long after a 30-second function could have is a kill', () => {
    assert.ok(effectiveRunStatus({ status: 'running', startedAt: ago(5 * 60_000) }, now) === 'killed');
  });

  test('a run that started moments ago is in progress, not killed', () => {
    assert.ok(effectiveRunStatus({ status: 'running', startedAt: ago(10_000) }, now) === 'running');
  });

  test('completed rows keep what they recorded', () => {
    assert.ok(effectiveRunStatus({ status: 'failed', startedAt: ago(9e6) }, now) === 'failed');
    assert.ok(effectiveRunStatus({ status: 'success', startedAt: ago(9e6) }, now) === 'success');
  });
});

suite('what is not a failed draft', () => {
  test('an account waiting for approval being refused is the system working', () => {
    assert.ok(isApprovalRefusal(new BudgetExceededError('approval', 'pending')));
  });

  test('running out of the daily allowance still counts as a failure worth seeing', () => {
    assert.ok(!isApprovalRefusal(new BudgetExceededError('daily', '400/400 calls today')));
    assert.ok(!isApprovalRefusal(new Error('provider down')));
  });
});
