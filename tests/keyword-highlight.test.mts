import { suite, test, assert } from './harness.mjs';
import { splitByKeywords } from '../components/keyword-split';

const kinds = (t: string, m: string[], x: string[] = []) =>
  splitByKeywords(t, m, x).filter((s) => s.kind !== 'plain').map((s) => `${s.kind}:${s.text}`);

suite('keyword highlight matching', () => {
  test('is case-insensitive and keeps original casing', () => {
    assert.deepEqual(kinds('Built with REACT.', ['react']), ['matched:REACT']);
  });
  test('respects word boundaries', () => {
    assert.deepEqual(kinds('React and Java, not JavaScript', ['Java', 'C']), ['matched:Java']);
  });
  test('escapes regex characters and handles symbol terms', () => {
    assert.deepEqual(kinds('Wrote C++ and .NET code', ['C++', '.NET']), ['matched:C++', 'matched:.NET']);
  });
  test('prefers the longest term and flags missing', () => {
    assert.deepEqual(kinds('React Native app', ['React', 'React Native'], ['Kafka']), ['matched:React Native']);
    assert.deepEqual(kinds('uses Kafka', [], ['kafka']), ['missing:Kafka']);
  });
  test('no terms returns the text untouched', () => {
    assert.deepEqual(splitByKeywords('abc', []), [{ text: 'abc', kind: 'plain' }]);
  });
});
