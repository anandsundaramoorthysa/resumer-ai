import { suite, test, assert } from './harness.mjs';
import { marketSignal } from '../lib/radar/market';
import type { Posting } from '../lib/serp/types';

const p = (description: string, min = 0, max = 0, source: 'serp' | 'regex' | 'none' = 'none'): Posting => ({
  key: `${description}|${min}|${max}|${source}`, title: 'Dev', company: 'c', location: '', via: '', description, applyLinks: [], postedAt: '',
  scheduleType: '', salaryLpa: { min, max, source }, highlights: [], serpJobId: '', fromQuery: 0,
});
const sal = (n: number) => p('x', n, n, 'serp');

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
  test('fewer than 3 midpoints: n reported, percentiles 0 (UI treats n<3 as no data)', () => {
    assert.deepEqual(marketSignal([sal(10), sal(20)], []).salaryLpa, { p25: 0, median: 0, p75: 0, n: 2 });
    assert.deepEqual(marketSignal([sal(10)], []).salaryLpa, { p25: 0, median: 0, p75: 0, n: 1 });
    assert.equal(marketSignal([sal(10), sal(20), sal(30)], []).salaryLpa.median, 20);
  });
  test('salaries outside 1-200 LPA are ignored', () => {
    const r = marketSignal([sal(0.5), sal(250), sal(10), sal(20), sal(30), sal(1), sal(200)], []).salaryLpa;
    assert.equal(r.n, 5);
    assert.equal(r.median, 20);
  });
  test('winsorise at n >= 10 keeps the inter-quartile range sane with an outlier', () => {
    const ten = [10, 11, 12, 13, 14, 15, 16, 17, 18, 190].map(sal);
    const w = marketSignal(ten, []).salaryLpa;
    assert.deepEqual(w, { p25: 12.3, median: 14.5, p75: 16.8, n: 10 });
  });
  test('held uses the ranker matcher (Go skill, ReactJS)', () => {
    const r = marketSignal([p('Golang and React.')], ['Go', 'ReactJS']);
    assert.deepEqual(r.topSkills.map((s) => [s.skill, s.held]).sort(), [['go', true], ['react', true]]);
  });
});
