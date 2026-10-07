/**
 * Boundary cases that mutation testing showed nothing was pinning: every `<` vs `<=`, `>=` vs
 * `>` and `?? false` below survived a hand-run mutation pass over the module named in the
 * heading, meaning a test suite could pass with the operator flipped.
 *
 * Each assertion sits exactly ON the edge and one step either side of it.
 */

import { suite, test, assert } from './harness.mjs';
import { matchesSkill, profileSeniority, rankPostings } from '../lib/radar/ranker';
import { parseSalaryLpa } from '../lib/serp/salary';
import { isBlocked } from '../lib/serp/budget';
import { BudgetExceededError, DraftBudget } from '../lib/ai/budget';
import { canon, findScopeInflation, findUngroundedTokens } from '../lib/generate/grounding';
import type { Posting } from '../lib/serp/types';
import type { ProfileRecord, RoleRecord } from '../lib/types';

/* ------------------------------------------------------------- lib/radar/ranker -- */

suite('ranker: matchesSkill', () => {
  test('an unknown term never matches, whatever the text', () => {
    assert.equal(matchesSkill('x', 'unknown'), false);
    assert.equal(matchesSkill('python python python', 'not-in-the-lexicon'), false);
    assert.equal(matchesSkill('', 'python'), false);
    assert.equal(matchesSkill('I write Python daily', 'python'), true);
  });
});

suite('ranker: profileSeniority thresholds', () => {
  const at = (y: number) => profileSeniority(y);
  test('intern below 0.5 years, entry from 0.5', () => {
    assert.equal(at(0), 'intern');
    assert.equal(at(0.49), 'intern');
    assert.equal(at(0.5), 'entry');
  });
  test('entry below 2, mid from 2', () => {
    assert.equal(at(1.99), 'entry');
    assert.equal(at(2), 'mid');
  });
  test('mid below 5, senior from 5', () => {
    assert.equal(at(4.99), 'mid');
    assert.equal(at(5), 'senior');
    assert.equal(at(30), 'senior');
  });
});

const base = { userId: 'u', source: 'manual' as const, flaggedForRemoval: false, reviewState: 'approved' as const, createdAt: new Date(), updatedAt: new Date() };
const docker = { ...base, id: 's1', type: 'skill', name: 'Docker', category: 'tool', tags: [], contentHash: 's1' } as unknown as ProfileRecord;
const role = (title: string, startDate: string, endDate = 'present'): RoleRecord =>
  ({ id: title, userId: 'u', title, company: 'Acme', startDate, endDate, source: 'manual', contentHash: title, reviewState: 'approved' });
const posting = (key: string, title: string, description: string, over: Partial<Posting> = {}): Posting => ({
  key, title, company: key, location: 'Mumbai', via: '', description, applyLinks: [], postedAt: '',
  scheduleType: '', salaryLpa: { min: 0, max: 0, source: 'none' }, highlights: [], serpJobId: '', fromQuery: 0, ...over,
}) as Posting;
const LONG = ' We are hiring and you will work with a great team on many interesting problems every day.'.repeat(2);
/** Eight years in one job -> profile seniority 'senior'. 'Barista' names no skill family. */
const SENIOR_PROFILE = { records: [docker], roles: [role('Barista', '2010-01', '2018-01')], contact: { fullName: 'A', email: 'a@b.c' } };
const scoreOf = (p: Posting, profile = SENIOR_PROFILE) => rankPostings([p], profile)[0].score;
// One of one skills held: smoothed = 1 / 3, so the skills part is 80 / 3 = 26.67 and each
// bonus below moves the rounded total by a known amount.
const SKILLS_PART = 80 / 3;

suite('ranker: seniority bonus (10 same, 5 adjacent, 0 far, 3 unknown) and the score formula', () => {
  test('same band: +10', () => {
    assert.equal(scoreOf(posting('a', 'Senior Cook', `Uses Docker.${LONG}`)), Math.round(SKILLS_PART + 10));
  });
  test('adjacent band: +5', () => {
    assert.equal(scoreOf(posting('a', 'Lead Cook', `Uses Docker.${LONG}`)), Math.round(SKILLS_PART + 5));
  });
  test('two bands away: +0', () => {
    assert.equal(scoreOf(posting('a', 'Junior Cook', `Uses Docker.${LONG}`)), Math.round(SKILLS_PART + 0));
  });
  test('no stated level: +3', () => {
    assert.equal(scoreOf(posting('a', 'Cook', `Uses Docker.${LONG}`)), Math.round(SKILLS_PART + 3));
  });
  test('remote: +5; a named city that is not the profile\'s: +0', () => {
    const remote = scoreOf(posting('a', 'Cook', `Uses Docker.${LONG}`, { location: 'Remote' }));
    const far = scoreOf(posting('a', 'Cook', `Uses Docker.${LONG}`, { location: 'Mumbai' }));
    assert.equal(remote - far, 5);
  });
  test('a title in one of the profile\'s own families: +8', () => {
    const analyst = { ...SENIOR_PROFILE, roles: [role('Data Analyst', '2010-01', '2018-01')] };
    const withFamily = scoreOf(posting('a', 'Reporting Analyst', `Uses Docker.${LONG}`), analyst);
    const without = scoreOf(posting('a', 'Cook', `Uses Docker.${LONG}`), analyst);
    // Same unknown-level +3 either way; the family accounts for the rest.
    assert.equal(withFamily - without, 8);
  });
  test('the score is capped at 100', () => {
    const many = Array.from({ length: 1 }, () => posting('a', 'Senior Cook', `Uses Docker.${LONG}`, { location: 'Remote' }));
    assert.ok(rankPostings(many, SENIOR_PROFILE)[0].score <= 100);
  });
});

suite('ranker: the short-description cutoff is exactly 120 characters', () => {
  const padTo = (n: number) => `Docker${'.'.repeat(n - 'Docker'.length)}`;
  const reasonOf = (description: string, highlights: string[] = []) =>
    rankPostings([posting('a', 'Cook', description, { highlights })], SENIOR_PROFILE)[0];
  test('119 chars is short; 120 is not', () => {
    assert.equal(padTo(119).length, 119);
    assert.match(reasonOf(padTo(119)).reason, /short description/);
    assert.doesNotMatch(reasonOf(padTo(120)).reason, /short description/);
    assert.doesNotMatch(reasonOf(padTo(121)).reason, /short description/);
  });
  test('the length is measured after trimming', () => {
    assert.doesNotMatch(reasonOf(`  ${padTo(120)}  `).reason, /short description/);
    assert.match(reasonOf(`  ${padTo(119)}  `).reason, /short description/);
  });
  test('short is a 0.8 penalty on exactly the raw score', () => {
    const full = rankPostings([posting('a', 'Senior Cook', padTo(120))], SENIOR_PROFILE)[0].score;
    const short = rankPostings([posting('a', 'Senior Cook', padTo(119))], SENIOR_PROFILE)[0].score;
    assert.equal(full, Math.round(SKILLS_PART + 10));
    assert.equal(short, Math.round((SKILLS_PART + 10) * 0.8));
  });
  test('a highlight makes it not short', () => {
    assert.doesNotMatch(reasonOf(padTo(10), ['Docker daily']).reason, /short description/);
  });
});

/* ----------------------------------------------------------- lib/serp/salary -- */

suite('salary: the 1..200 LPA window is inclusive at both ends', () => {
  const lpa = (n: number | string) => parseSalaryLpa(`Salary: ${n} LPA`);
  test('1 LPA is accepted, 0.99 is not', () => {
    assert.deepEqual(lpa(1), { min: 1, max: 1, source: 'regex' });
    assert.equal(lpa(0.99).source, 'none');
  });
  test('200 LPA is accepted, 201 is not', () => {
    assert.deepEqual(lpa(200), { min: 200, max: 200, source: 'regex' });
    assert.equal(lpa(201).source, 'none');
  });
  test('a range is accepted only if BOTH ends are inside', () => {
    assert.deepEqual(parseSalaryLpa('Salary: 1 - 200 LPA'), { min: 1, max: 200, source: 'regex' });
    assert.equal(parseSalaryLpa('Salary: 0.5 - 20 LPA').source, 'none');
    assert.equal(parseSalaryLpa('Salary: 20 - 250 LPA').source, 'none');
  });
  test('a reversed range is put in order', () => {
    assert.deepEqual(parseSalaryLpa('Salary: 18 to 12 LPA'), { min: 12, max: 18, source: 'regex' });
  });
});

suite('salary: the other edges', () => {
  test('an annual figure of exactly 100000 is 1 LPA; 99999 is not read as a salary', () => {
    assert.deepEqual(parseSalaryLpa('Salary ₹100000 per annum'), { min: 1, max: 1, source: 'regex' });
    assert.equal(parseSalaryLpa('Salary ₹99999 per annum').source, 'none');
  });
  test('a bare CTC of exactly 100000 is 1 LPA; below it is not', () => {
    assert.deepEqual(parseSalaryLpa('CTC: 100000'), { min: 1, max: 1, source: 'regex' });
    assert.equal(parseSalaryLpa('CTC: 99999').source, 'none');
  });
  test('"40k per month" is multiplied by a thousand and annualised: 4.8 LPA', () => {
    assert.deepEqual(parseSalaryLpa('Stipend: 40k per month'), { min: 4.8, max: 4.8, source: 'regex' });
    assert.deepEqual(parseSalaryLpa('Stipend: 40000 per month'), { min: 4.8, max: 4.8, source: 'regex' });
  });
  test('a foreign currency AFTER the figure rejects it (the window looks forward as well as back)', () => {
    assert.equal(parseSalaryLpa('CTC 15 LPA, paid in USD').source, 'none');
    assert.equal(parseSalaryLpa('CTC 15 LPA, paid in INR').source, 'regex');
  });
  test('SerpApi\'s own salary field needs no cue word; the free text does', () => {
    assert.deepEqual(parseSalaryLpa('', '12 lakhs'), { min: 12, max: 12, source: 'serp' });
    assert.equal(parseSalaryLpa('about 12 lakhs for the right person').source, 'none');
    assert.equal(parseSalaryLpa('salary about 12 lakhs for the right person').source, 'regex');
  });
});

/* ----------------------------------------------------------- lib/serp/budget -- */

suite('serp guard: isBlocked(left, used)', () => {
  test('fewer than 10 searches left blocks; exactly 10 does not', () => {
    assert.equal(isBlocked(10, 0), false);
    assert.equal(isBlocked(9, 0), true);
    assert.equal(isBlocked(0, 0), true);
  });
  test('an unknown balance (-1) never blocks on its own', () => {
    assert.equal(isBlocked(-1, 0), false);
    assert.equal(isBlocked(-1, 44), false);
  });
  test('45 attempts this hour blocks; 44 does not', () => {
    assert.equal(isBlocked(50, 44), false);
    assert.equal(isBlocked(50, 45), true);
    assert.equal(isBlocked(50, 46), true);
  });
  test('either condition alone is enough', () => {
    assert.equal(isBlocked(9, 45), true);
    assert.equal(isBlocked(500, 0), false);
  });
});

/* ------------------------------------------------------------ lib/ai/budget -- */

suite('DraftBudget: caps are inclusive of the limit', () => {
  const LIMITS = { maxCalls: 4, maxTokens: 10_000 };
  test('tokens: refused AT maxTokens, allowed one below', () => {
    const b = new DraftBudget(LIMITS, 50_000);
    b.record(LIMITS.maxTokens - 1);
    assert.doesNotThrow(() => b.assertCanSpend());
    b.record(1);
    assert.throws(() => b.assertCanSpend(), BudgetExceededError);
  });
  test('calls: refused AT maxCalls, allowed one below', () => {
    const b = new DraftBudget(LIMITS, 50_000);
    for (let i = 0; i < LIMITS.maxCalls - 1; i++) b.record(1);
    assert.doesNotThrow(() => b.assertCanSpend());
    b.record(1);
    assert.throws(() => b.assertCanSpend(), BudgetExceededError);
  });
  test('time: refused once the whole budget is spent, not before', () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      const b = new DraftBudget(LIMITS, 50_000);
      clock += 49_999;
      assert.doesNotThrow(() => b.assertCanSpend());
      clock += 1;
      assert.throws(() => b.assertCanSpend(), BudgetExceededError);
    } finally {
      Date.now = realNow;
    }
  });
  test('another scoring iteration needs strictly more than the estimate remaining', () => {
    const realNow = Date.now;
    Date.now = () => 5_000_000;
    try {
      const b = new DraftBudget(LIMITS, 20_000);
      assert.equal(b.hasTimeForAnotherIteration(20_000), false, 'exactly the estimate left: no');
      assert.equal(b.hasTimeForAnotherIteration(19_999), true);
    } finally {
      Date.now = realNow;
    }
  });
});

/* ------------------------------------------------------ lib/generate/grounding -- */

suite('grounding: the single-claim cutoff and the posting-term check', () => {
  const hedged = (len: number) => `Helped ${'a'.repeat(len - 'Helped '.length)}`;
  test('a hedge in a source of exactly 400 characters is protected; at 401 the source is a corpus', () => {
    assert.equal(canon(hedged(400)).length, 400);
    assert.deepEqual(findScopeInflation('Built the thing.', hedged(400)).map((v) => v.token), ['helped']);
    assert.deepEqual(findScopeInflation('Built the thing.', hedged(401)), []);
    assert.deepEqual(findScopeInflation('Built the thing.', hedged(399)).map((v) => v.token), ['helped']);
  });
  test('ownership is checked at any length', () => {
    assert.equal(findScopeInflation('Led the migration.', hedged(401)).length, 1);
  });
  test('keeping the hedge is fine at 400', () => {
    assert.deepEqual(findScopeInflation('Helped with the thing.', hedged(400)), []);
  });
  test('a posting term the rewrite adds and the source lacks is a violation; one the source has is not', () => {
    const v = findUngroundedTokens('built pipelines for forecasting', 'built pipelines', ['forecasting']);
    assert.deepEqual(v.filter((x) => x.kind === 'keyword').map((x) => x.token), ['forecasting']);
    assert.deepEqual(findUngroundedTokens('built pipelines for forecasting', 'built pipelines for forecasting', ['forecasting']), []);
  });
  test('without posting terms the keyword check is silent', () => {
    assert.deepEqual(findUngroundedTokens('built pipelines for forecasting', 'built pipelines', []), []);
    assert.deepEqual(findUngroundedTokens('built pipelines for forecasting', 'built pipelines'), []);
  });
  test('only the terms that are actually newly present are named', () => {
    const v = findUngroundedTokens('built pipelines for forecasting and experimentation', 'built pipelines for experimentation', ['forecasting', 'experimentation', 'segmentation']);
    assert.deepEqual(v.map((x) => x.token), ['forecasting']);
  });
});
