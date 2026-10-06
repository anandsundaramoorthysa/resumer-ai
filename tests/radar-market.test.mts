import { suite, test, assert } from './harness.mjs';
import { marketSignal } from '../lib/radar/market';
import type { Posting } from '../lib/serp/types';

const p = (description: string, min = 0, max = 0, source: 'serp' | 'regex' | 'none' = 'none'): Posting => ({
  key: description, title: 'Dev', company: 'c', location: '', via: '', description, applyLinks: [], postedAt: '',
  scheduleType: '', salaryLpa: { min, max, source }, highlights: [], serpJobId: '', fromQuery: 0,
});

suite('marketSignal', () => {
  const ps = [
    p('Python SQL', 10, 10, 'serp'),
    p('Python Docker', 20, 20, 'regex'),
    p('Python AWS', 30, 30, 'serp'),
    p('Python Docker', 40, 40, 'serp'),
    p('SQL', 0, 0, 'none'),
  ];
  const m = marketSignal(ps, ['Python']);
  test('salary percentiles over postings with a salary', () => {
    assert.deepEqual(m.salaryLpa, { p25: 17.5, median: 25, p75: 32.5, n: 4 });
    assert.equal(m.sampleSize, 5);
  });
  test('top skills with pct and held flag', () => {
    assert.deepEqual(m.topSkills[0], { skill: 'python', pct: 80, held: true });
    assert.equal(m.topSkills.find((s) => s.skill === 'sql')?.pct, 40);
  });
  test('gapSkills are in-demand and not held', () => {
    assert.ok(!m.gapSkills.includes('python'));
    assert.ok(m.gapSkills.includes('sql'));
    assert.ok(m.gapSkills.includes('docker'));
  });
  test('empty input gives zeros', () => {
    assert.deepEqual(marketSignal([], []), {
      sampleSize: 0, salaryLpa: { p25: 0, median: 0, p75: 0, n: 0 }, topSkills: [], gapSkills: [],
    });
  });
});
