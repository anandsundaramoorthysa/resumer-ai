/**
 * Which extracted terms count as ATS keywords — lib/intake/extract.ts.
 *
 * Coverage is `matched / atsKeywords`, a pass/fail gate at 70%. So a term no resume could
 * ever contain is not noise, it is a permanent subtraction: on a real EA analyst
 * internship forwarded by a placement cell, 11 of 22 keywords were Stipend, CGPA,
 * backlogs, PPO, Hybrid, 6 months and the like, and the gate was unreachable by any
 * resume however well matched.
 *
 * The two directions both matter, and the second is the dangerous one: dropping too much
 * silently deletes the skills the whole match is built on, and would show up as a better
 * score rather than as a failure.
 */

import { stripAdministrativeKeywords } from '../lib/intake/extract';
import { suite, test, assert } from './harness.mjs';

const strip = (kw: string[], company?: string) => stripAdministrativeKeywords(kw, company);
const kept = (term: string, company?: string) => strip([term], company).length === 1;

suite('what the posting says about itself is dropped', () => {
  test('the live case — half the denominator was the hiring process', () => {
    // Verbatim from the production run that scored 12%.
    const extracted = [
      'Product Analyst Intern', 'SQL', 'R', 'Python', 'Data Visualization', 'Hybrid',
      'Hyderabad', 'Internship', 'Stipend', 'PPO', 'Pre-Placement Offer', 'EA',
      'Electronic Arts', 'M.Sc.', 'Statistics', 'Data Science', '7 CGPA',
      'no active backlogs', '6 months', 'Post-Conversion CTC',
    ];
    const out = strip(extracted, 'Electronic Arts (EA) India');

    for (const skill of ['SQL', 'R', 'Python', 'Data Visualization', 'Statistics', 'Data Science']) {
      assert.ok(out.includes(skill), `${skill} is a real requirement and must survive`);
    }
    for (const noise of ['Hybrid', 'Stipend', 'PPO', 'Pre-Placement Offer', 'EA',
                         'Electronic Arts', '7 CGPA', 'no active backlogs', '6 months',
                         'Post-Conversion CTC', 'Internship']) {
      assert.ok(!out.includes(noise), `${noise} cannot appear in a resume and must go`);
    }
  });

  test('compensation in any of the shapes a posting writes it', () => {
    for (const t of ['Stipend', 'CTC', 'LPA', '₹50,000', 'Rs. 50,000', '15-18 LPA',
                     '50,000 per month', 'Salary', 'all-inclusive']) {
      assert.ok(!kept(t), `${t} should be dropped`);
    }
  });

  test('eligibility administration', () => {
    for (const t of ['CGPA', '7 CGPA', 'Minimum 7 CGPA', 'backlogs', 'no active backlogs',
                     'final year', 'batch 2027', '2027 batch', '60%']) {
      assert.ok(!kept(t), `${t} should be dropped`);
    }
  });

  test('work arrangement and duration', () => {
    for (const t of ['Hybrid', 'Remote', 'On-site', 'work from home', '6 months',
                     '3 days a week', 'full-time']) {
      assert.ok(!kept(t), `${t} should be dropped`);
    }
  });

  test('the hiring process', () => {
    for (const t of ['PPO', 'Pre-Placement Offer', 'application deadline',
                     'registration link', 'notice period', 'immediate joiner']) {
      assert.ok(!kept(t), `${t} should be dropped`);
    }
  });

  test('the employer’s own name, however the posting abbreviates it', () => {
    assert.ok(!kept('EA', 'Electronic Arts (EA) India'));
    assert.ok(!kept('Electronic Arts', 'Electronic Arts (EA) India'));
    assert.ok(!kept('Zoho', 'Zoho Corporation'));
  });

  test('with no company known, nothing is dropped on that account', () => {
    assert.ok(kept('Electronic Arts'));
  });
});

suite('what a candidate can demonstrate is kept', () => {
  test('a single-letter language survives — R is a real requirement here', () => {
    assert.ok(kept('R'));
  });

  test('the role title is kept — ATS filters match on it', () => {
    assert.ok(kept('Product Analyst Intern'));
    assert.ok(kept('Analyst Intern'));
  });

  test('a skill that merely contains an administrative word is not touched', () => {
    // The substring trap: "hybrid" is a work arrangement, "hybrid cloud architecture"
    // is a skill. A contains-check would eat the second to catch the first.
    for (const t of ['hybrid cloud architecture', 'remote sensing', 'contract testing',
                     'shift-left testing', 'package management', 'application security',
                     'batch processing', 'time series forecasting']) {
      assert.ok(kept(t), `${t} is a genuine skill and must survive`);
    }
  });

  test('every technical term from the real JD survives', () => {
    const jd = [
      'SQL', 'joins', 'aggregations', 'CTEs', 'window functions', 'R', 'Python',
      'data analysis', 'statistics', 'regression', 'classification', 'clustering',
      'train/test validation', 'model evaluation', 'overfitting', 'player engagement',
      'retention', 'monetization', 'experimentation', 'segmentation', 'forecasting',
      'anomaly detection', 'visualization',
    ];
    assert.deepEqual(strip(jd, 'Electronic Arts (EA) India'), jd);
  });

  test('an empty or blank keyword is dropped rather than counted', () => {
    assert.deepEqual(strip(['', '   ', 'SQL']), ['SQL']);
  });
});

suite("other people's job titles", () => {
  const ea = (kw: string) => stripAdministrativeKeywords([kw], 'Electronic Arts (EA) India', 'Product Analyst Intern').length === 1;

  test('the team the candidate would work alongside is not a keyword', () => {
    // Both came back from the real EA posting, which describes mentoring by them.
    assert(!ea('analytics manager'), 'analytics manager');
    assert(!ea('senior analyst'), 'senior analyst');
    assert(!ea('engineering manager'), 'engineering manager');
  });

  test("the posting's own title stays, in whatever form it appears", () => {
    assert(ea('Product Analyst Intern'), 'the full title');
    assert(ea('Product Analyst'), 'part of it');
    assert(ea('analyst'), 'the bare noun, which is this job');
  });

  test('skills that merely end in a title-like word are untouched', () => {
    for (const term of ['stakeholder management', 'data science', 'product analytics', 'engineering', 'leadership']) {
      assert(ea(term), term);
    }
  });

  test('with no role title known, nothing is dropped by this rule', () => {
    assert(stripAdministrativeKeywords(['analytics manager'], undefined, '').length === 1, 'kept');
  });
});
