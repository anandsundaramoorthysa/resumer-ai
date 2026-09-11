/**
 * Which provider failures bench the provider — lib/ai/chain.ts.
 *
 * In production the first provider answered every structured call with "This model is
 * currently experiencing high demand", and that was not recognised as a reason to stop
 * asking it: benching fired only for quota errors and timeouts. So the chain asked the
 * same overloaded provider again through its second path, that attempt spent the rest of
 * the deadline, and the provider that would have answered in three seconds was never
 * reached.
 *
 * Both directions are pinned, because both are expensive. A real outage that does not
 * bench wastes the deadline on a provider that cannot answer; a false match benches a
 * healthy one for a minute and throws away the provider that is working.
 */

import { attemptWindow as attemptWindowForTest, benchReason } from '../lib/ai/chain';
import { suite, test, assert } from './harness.mjs';

/** Verbatim, from the production function log. */
const GEMINI_OVERLOAD =
  'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.';

suite('provider failures — which ones bench the provider', () => {
  test('the production overload benches, whatever ended the attempt', () => {
    assert.equal(benchReason(GEMINI_OVERLOAD), 'overload');
    assert.equal(
      benchReason(GEMINI_OVERLOAD, true),
      'overload',
      'the provider said it, not our deadline — cutShort must not excuse it',
    );
  });

  test('other overload wordings are recognised', () => {
    assert.equal(benchReason('The server is overloaded'), 'overload');
    assert.equal(benchReason('Service Unavailable'), 'overload');
    assert.equal(benchReason('The model is temporarily unavailable'), 'overload');
  });

  test('quota still benches as quota, for the longer cooldown', () => {
    assert.equal(benchReason('You exceeded your current quota'), 'quota');
    assert.equal(benchReason('429 Too Many Requests'), 'quota');
  });

  test('a timeout benches as slow — unless our own deadline cut it short', () => {
    assert.equal(benchReason('The operation was aborted due to timeout'), 'slow');
    assert.equal(benchReason('The operation was aborted due to timeout', true), null);
  });

  test('a response our schema refused says nothing about the provider', () => {
    // The provider answered and was billed. Benching it would discard the one provider
    // that was working — both of these appeared in the same production log.
    assert.equal(
      benchReason('requiredSkills.7: Too big: expected string to have <=120 characters'),
      null,
    );
    assert.equal(
      benchReason("invalid JSON schema for response_format: 'response': /required"),
      null,
    );
  });

  test('a number that merely contains 503 does not bench', () => {
    assert.equal(benchReason('prompt used 5031 tokens'), null);
  });
});

suite('an attempt window is a whole number of milliseconds', () => {
  test('AbortSignal.timeout refuses a fraction, and every provider then fails at once', () => {
    const w = attemptWindowForTest(Date.now() + 7162.7, 10_000);
    assert(Number.isInteger(w.ms), `got ${w.ms}`);
  });
});

suite('what must never bench a provider', () => {
  test('a run of digits is not an HTTP 429', () => {
    assert(benchReason('The value of "delay" is out of range. Received 4297.2') === null, 'our own bug');
    assert(benchReason('Request failed with status 429') === 'quota', 'a real one still benches');
  });

  test('a fault on this side benches nothing', () => {
    for (const m of ['x is not a function', 'Cannot read properties of undefined', 'invalid_type in response']) {
      assert(benchReason(m) === null, m);
    }
  });
});
