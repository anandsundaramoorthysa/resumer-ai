/** Fixture-level sanity: five profiles against the recorded SerpApi postings. */
import { readFileSync, readdirSync } from 'node:fs';
import { suite, test, assert } from './harness.mjs';
import { normalizeJobs, dedupePostings } from '../lib/serp/normalize';
import { rankPostings, NO_MATCH_REASON } from '../lib/radar/ranker';
import { marketSignal } from '../lib/radar/market';
import type { ProfileRecord, RoleRecord } from '../lib/types';

const dir = new URL('../fixtures/serpapi/', import.meta.url);
const postings = dedupePostings(
  readdirSync(dir)
    .filter((f) => f.startsWith('jobs-'))
    .flatMap((f) => normalizeJobs(JSON.parse(readFileSync(new URL(f, dir), 'utf8')))),
);

const sk = (n: string) =>
  ({ id: n, userId: 'u', type: 'skill', name: n, category: 'tool', tags: [], source: 'manual', contentHash: n, flaggedForRemoval: false, reviewState: 'approved', createdAt: new Date(), updatedAt: new Date() }) as ProfileRecord;
const role = (title: string, startDate: string, endDate: string): RoleRecord =>
  ({ id: title, userId: 'u', title, company: 'Acme', startDate, endDate, source: 'manual', contentHash: title, reviewState: 'approved' });
const profile = (skills: string[], roles: RoleRecord[], location?: string) => ({
  records: skills.map(sk), roles, contact: { fullName: 'A', email: 'a@b.c', location },
});
const fresher = profile(['Python', 'Machine Learning', 'Pandas', 'NumPy', 'SQL', 'TensorFlow', 'Git'], [role('ML Intern', '2026-01', '2026-06')], 'Hyderabad, India');
const fullstack = profile(['JavaScript', 'TypeScript', 'React', 'Node.js', 'Express', 'MongoDB', 'PostgreSQL', 'Docker', 'AWS', 'Git', 'HTML', 'CSS'], [role('Full Stack Developer', '2022-06', 'present')], 'Bengaluru, Karnataka');
const analyst = profile(['SQL', 'Tableau', 'Excel', 'Power BI', 'Python', 'Data Analysis'], [role('Data Analyst', '2023-01', 'present')], 'Chennai');
const marketing = profile(['SEO', 'Content Marketing', 'Google Analytics', 'Copywriting', 'Social Media'], [role('Marketing Executive', '2021-01', 'present')], 'Mumbai');
const empty = profile([], [], undefined);

const byTitle = (p: typeof fresher) => {
  const out = new Map<string, number>();
  for (const r of rankPostings(postings, p, 50)) out.set(postings.find((x) => x.key === r.key)!.title, r.score);
  return out;
};

suite('radar quality on fixtures', () => {
  test('fixtures loaded', () => assert.equal(postings.length, 11));

  test('fresher ML: relevant outranks irrelevant, ML skill counts', () => {
    const s = byTitle(fresher);
    assert.ok(s.get('Machine Learning Engineer')! > s.get('Frontend Engineer')!);
    assert.ok(s.get('Associate Data Scientist')! > s.get('Junior Web Developer')!);
    const mle = rankPostings(postings, fresher, 50).find((r) => postings.find((p) => p.key === r.key)!.title === 'Machine Learning Engineer')!;
    assert.ok(mle.matched.includes('machine learning'));
    assert.equal(s.get('Frontend Engineer'), 0);
  });
  test('full-stack: web postings on top, data postings no-match', () => {
    const r = rankPostings(postings, fullstack, 50);
    const t = (x: { key: string }) => postings.find((p) => p.key === x.key)!.title;
    assert.ok(/Web|Full Stack|Frontend/.test(t(r[0])));
    const da = r.find((x) => t(x) === 'Data Analyst')!;
    assert.equal(da.score, 0);
    assert.equal(da.reason, NO_MATCH_REASON);
  });
  test('analyst: analyst postings on top', () => {
    const r = rankPostings(postings, analyst, 2);
    assert.ok(r.every((x) => /Analyst/.test(postings.find((p) => p.key === x.key)!.title)));
  });
  test('marketing profile: every posting is a no-match', () => {
    for (const r of rankPostings(postings, marketing, 50)) {
      assert.equal(r.score, 0);
      assert.equal(r.reason, NO_MATCH_REASON);
    }
  });
  test('empty profile: every score is zero', () => {
    for (const r of rankPostings(postings, empty, 50)) assert.equal(r.score, 0);
  });
  test('shuffled input gives the same ranking for every profile', () => {
    const shuffled = [...postings].reverse();
    for (const p of [fresher, fullstack, analyst, marketing, empty]) {
      assert.deepEqual(rankPostings(shuffled, p, 50), rankPostings(postings, p, 50));
    }
  });
  test('no-match always sorts after matches', () => {
    const r = rankPostings(postings, fullstack, 50);
    const firstZero = r.findIndex((x) => x.score === 0);
    assert.ok(r.slice(firstZero).every((x) => x.score === 0));
  });
  test('market over fixtures: salaries sane, n >= 3', () => {
    const m = marketSignal(postings, ['Python']);
    assert.ok(m.salaryLpa.n >= 3 && m.salaryLpa.median > 1 && m.salaryLpa.median < 200);
    assert.ok(!m.topSkills.some((s) => ['testing', 'express'].includes(s.skill)));
  });
});
