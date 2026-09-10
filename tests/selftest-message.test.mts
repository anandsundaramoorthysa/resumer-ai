/**
 * The finish line may not claim a check that did not run — lib/render/selftest.ts.
 *
 * In production the PDF verifier could not start. selfTest() let the draft through on the
 * strength of the DOCX check, which is the right call, and the progress row still
 * announced "Both files verified — text extracts cleanly (0 chars from the PDF)": a claim
 * of verification beside a count that showed nothing had been read.
 */

import { verifiedMessage } from '../lib/render/selftest';
import { suite, test, assert } from './harness.mjs';

const ran = (chars: number) => ({ extractedChars: chars, issues: [] as Array<{ check: string }> });
const couldNotStart = { extractedChars: 0, issues: [{ check: 'parser-unavailable' }] };

suite('self-test message — never claims a check that did not run', () => {
  test('both checks ran: both are called verified', () => {
    assert.match(verifiedMessage(ran(2200), ran(2100)), /^Both files verified/);
  });

  test('the production case: the PDF checker could not start', () => {
    const message = verifiedMessage(couldNotStart, ran(2100));
    assert.doesNotMatch(message, /Both files verified/, 'the PDF was not verified');
    assert.doesNotMatch(message, /\b0 chars\b/, 'a zero count must not appear as a result');
    assert.match(message, /^DOCX verified/);
    assert.match(message, /PDF checker can.t run/, 'and it must say which check did not run');
  });

  test('the reverse case is reported the same way', () => {
    assert.match(verifiedMessage(ran(2200), couldNotStart), /^PDF verified/);
  });

  test('neither checker ran: it says the files were not verified', () => {
    assert.match(verifiedMessage(couldNotStart, couldNotStart), /not verified/);
  });
});
