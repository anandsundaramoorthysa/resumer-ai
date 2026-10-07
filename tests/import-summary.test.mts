/**
 * The import summary keeps "already present" and "removed earlier" apart
 * (lib/import/commit.ts).
 */

import { summarize } from '../lib/import/commit';
import { suite, test, assert } from './harness.mjs';

suite('import summary wording', () => {
  test('REPRO: dismissed rows are no longer reported as "already present"', () => {
    // 3 selected, all removed by the user earlier: nothing is "already present".
    const msg = summarize(0, 0, 0, false, 0, 0, 3);
    assert.doesNotMatch(msg, /already/i);
    assert.match(msg, /removed earlier/);
  });

  test('already-present alone keeps the old sentence', () => {
    assert.equal(summarize(0, 2, 0, false, 0), 'Everything selected was already in your profile — nothing added.');
  });

  test('both are named when both happened', () => {
    assert.match(summarize(0, 1, 0, false, 0, 0, 2), /already in your profile or something you removed/);
    const msg = summarize(5, 1, 0, false, 0, 0, 2);
    assert.match(msg, /5 facts added/);
    assert.match(msg, /1 already present/);
    assert.match(msg, /2 removed earlier, skipped/);
  });

  test('nothing selected stays nothing', () => {
    assert.equal(summarize(0, 0, 0, false, 0), 'Nothing was selected, so nothing was added.');
  });
});
