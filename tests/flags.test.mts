/**
 * Regression tests for two defects that were knowingly shipped and then fixed.
 *
 * Both had the same shape: a check that looked strict, described itself as strict in a
 * comment, and was not. Tests exist here so the gap between claim and behaviour cannot
 * silently reopen.
 */

import { scoreKeywordCoverage } from '../lib/quality/keywords';
import { selfTest } from '../lib/render/selftest';
import { renderResumeDocx } from '../lib/render/docx';
import type { JobRequirement, ResumeDocument } from '../lib/types';
import { suiteAsync, test, testAsync, assert } from './harness.mjs';

function docWith(sections: ResumeDocument['sections'], job?: Partial<JobRequirement>): ResumeDocument {
  return {
    id: 'test',
    userId: 'test',
    contact: {
      fullName: 'Anand Sundaramoorthy',
      email: 'anand@example.com',
      phone: '+91 90000 00000',
      location: 'Chennai, India',
      portfolioUrl: 'anandsundaramoorthy.com',
    },
    sections,
    jobRequirement: job
      ? ({
          roleTitle: 'Engineer',
          seniority: 'mid',
          category: 'full-stack',
          requiredSkills: [],
          preferredSkills: [],
          responsibilities: [],
          atsKeywords: [],
          tone: 'neutral',
          confidence: 1,
          flags: [],
          ...job,
        } as JobRequirement)
      : null,
    renderMode: 'ats-strict',
    recordHashSnapshot: [],
    createdAt: new Date(),
  };
}

suiteAsync('flag fixes', async () => {
  /* ------------------------------------------------ flag 1: keyword matching -- */

  test('keyword coverage no longer counts a substring as a match', () => {
    const doc = docWith(
      [
        {
          key: 'skills',
          heading: 'Skills',
          items: [{ text: 'Node.js, PostgreSQL', sourceRecordId: null }],
        },
        {
          key: 'experience',
          heading: 'Experience',
          items: [
            { text: 'The service reacts to webhook events in real time.', sourceRecordId: null },
          ],
        },
      ],
      { atsKeywords: ['React'] },
    );

    const result = scoreKeywordCoverage(doc);
    assert(
      result.missing.includes('React'),
      '"reacts to" must not satisfy the keyword "React" — the old code counted it',
    );
  });

  test('a short keyword cannot be satisfied by its truncated stem', () => {
    const doc = docWith(
      [
        {
          key: 'skills',
          heading: 'Skills',
          items: [{ text: 'Computer Science, Node.js', sourceRecordId: null }],
        },
      ],
      { atsKeywords: ['CSS'] },
    );
    assert(
      scoreKeywordCoverage(doc).missing.includes('CSS'),
      'stripping the "s" from CSS to reach "CS" must not match "Computer Science"',
    );
  });

  test('genuine matches and real spelling variance still count', () => {
    const doc = docWith(
      [
        {
          key: 'skills',
          heading: 'Skills',
          items: [
            { text: 'React, Node.js, CI/CD, Google Analytics 4', sourceRecordId: null },
          ],
        },
      ],
      { atsKeywords: ['React', 'Node.js', 'CI/CD', 'Google Analytics 4'] },
    );
    const r = scoreKeywordCoverage(doc);
    assert(r.missing.length === 0, `all four should match, missing: ${r.missing.join(', ')}`);
  });

  test('a plural keyword still matches a singular in the text', () => {
    // Strip-only: the posting says "microservices", the resume says "microservice".
    const doc = docWith(
      [
        {
          key: 'skills',
          heading: 'Skills',
          items: [{ text: 'Microservice architecture, Dashboard design', sourceRecordId: null }],
        },
      ],
      { atsKeywords: ['microservices', 'dashboards'] },
    );
    const r = scoreKeywordCoverage(doc);
    assert(r.missing.length === 0, `plural keyword should match singular text, missing: ${r.missing.join(', ')}`);
  });

  /* --------------------------------------------- flag 2: skills region check -- */

  await testAsync('a dropped Skills section is caught even when the skill appears elsewhere', async () => {
    // The exact scenario the old check missed: "React" is gone from Skills but still
    // present in a project line, so a whole-document search found it and passed.
    const broken = docWith([
      {
        key: 'skills',
        heading: 'Skills',
        items: [{ text: 'React, PostgreSQL, TypeScript', sourceRecordId: null }],
      },
      {
        key: 'projects',
        heading: 'Projects',
        items: [],
        groups: [
          {
            title: 'Portfolio',
            subtitle: 'React, PostgreSQL, TypeScript',
            items: [{ text: 'Built with React and PostgreSQL and TypeScript.', sourceRecordId: null }],
          },
        ],
      },
    ]);

    // Render the document, then verify against a version claiming a Skills section the
    // rendered bytes do not contain.
    const withoutSkills = docWith([broken.sections[1]]);
    const docx = await renderResumeDocx(withoutSkills);
    const result = await selfTest(docx, 'docx', broken);

    const caught = result.issues.some(
      (i) =>
        i.severity === 'fail' &&
        (i.check === 'skills-extractable' || i.check === 'skills-section-extractable'),
    );
    assert(caught, `a missing Skills section must fail; issues: ${JSON.stringify(result.issues)}`);
  });

  await testAsync('an intact Skills section still passes cleanly', async () => {
    const good = docWith([
      {
        key: 'skills',
        heading: 'Skills',
        items: [{ text: 'React, PostgreSQL, TypeScript', sourceRecordId: null }],
      },
      {
        key: 'experience',
        heading: 'Experience',
        items: [],
        groups: [
          {
            title: 'Engineer',
            subtitle: 'Acme',
            dateRange: 'Jan 2022 – Present',
            items: [
              {
                text: 'Optimized PostgreSQL queries serving 200K daily requests, cutting p95 latency 40%.',
                sourceRecordId: null,
              },
            ],
          },
        ],
      },
    ]);

    const docx = await renderResumeDocx(good);
    const result = await selfTest(docx, 'docx', good);
    const fails = result.issues.filter((i) => i.severity === 'fail');
    assert(fails.length === 0, `a good document must raise nothing: ${JSON.stringify(fails)}`);
  });
});
