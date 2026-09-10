/**
 * Fitting the draft to the page — lib/generate/fit-page.ts.
 *
 * The assembler only drops whole tail sections, so a large profile ran 50 lines against a
 * 29-line page and failed the length rule on every draft. The trim that fixes it removes
 * content, which is the dangerous direction: removing the one line that carried a job
 * keyword, or trimming a resume from too long straight into too short, would each look
 * like a fix while making the resume worse. Both are pinned here.
 */

import { suite, test, assert } from './harness.mjs';
import { trimToPage } from '../lib/generate/fit-page';
import { lengthVerdict } from '../lib/quality/length';
import { scoreKeywordCoverage } from '../lib/quality/keywords';
import type { JobRequirement, ResumeDocument, ResumeSection } from '../lib/types';

const job: JobRequirement = {
  roleTitle: 'Platform Engineer',
  seniority: 'entry',
  category: 'full-stack',
  requiredSkills: [],
  preferredSkills: [],
  responsibilities: [],
  atsKeywords: ['Kubernetes'],
  tone: 'neutral',
  confidence: 1,
  flags: [],
};

/** `n` distinct filler words — distinct so nothing accidentally matches a keyword. */
const words = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `${seed}${String.fromCharCode(97 + (i % 26))}${i}`).join(' ');

function longDocument(opts: { projects?: number; wordsPerItem?: number } = {}): ResumeDocument {
  const projects = opts.projects ?? 10;
  const per = opts.wordsPerItem ?? 10;

  const projectGroups: NonNullable<ResumeSection['groups']> = Array.from(
    { length: projects },
    (_, g) => ({
      title: `Project ${g}`,
      subtitle: 'Stack',
      items: [
        {
          // The LAST project is the only place the job keyword appears — the one a naive
          // last-first trim would remove first.
          text: g === projects - 1 ? `Ran workloads on Kubernetes ${words(per - 4, `p${g}`)}` : words(per, `p${g}`),
          sourceRecordId: `p${g}`,
        },
        { text: words(per, `m${g}`), sourceRecordId: `p${g}` },
      ],
    }),
  );

  return {
    id: 'd1',
    userId: 'u1',
    contact: { fullName: 'A Candidate', email: 'a@example.com' },
    sections: [
      { key: 'skills', heading: 'Skills', items: [{ text: words(per, 'skill'), sourceRecordId: null }] },
      {
        key: 'experience',
        heading: 'Experience',
        items: [],
        groups: [
          {
            title: 'Engineer',
            subtitle: 'Acme',
            items: Array.from({ length: 5 }, (_, i) => ({ text: words(per, `b${i}`), sourceRecordId: `b${i}` })),
          },
        ],
      },
      { key: 'projects', heading: 'Projects', items: [], groups: projectGroups },
      { key: 'education', heading: 'Education', items: [{ text: words(per, 'edu'), sourceRecordId: 'e1' }] },
    ],
    jobRequirement: job,
    renderMode: 'ats-strict',
    recordHashSnapshot: [],
    createdAt: new Date('2024-01-01'),
  };
}

suite('fitting to the page', () => {
  test('a document past its page is trimmed until it fits', () => {
    const doc = longDocument();
    assert.equal(lengthVerdict(doc), 'long');
    const { document, removed } = trimToPage(doc);
    assert.equal(lengthVerdict(document), 'ok');
    assert.ok(removed.length > 0);
  });

  test('the only line carrying a job keyword survives, though it is last', () => {
    const { document } = trimToPage(longDocument());
    assert.equal(scoreKeywordCoverage(document).coveragePct, 1);
    const projects = document.sections.find((s) => s.key === 'projects');
    assert.ok(projects?.groups?.some((g) => g.title === 'Project 9'));
  });

  test('Skills and Education are never touched', () => {
    const before = longDocument();
    const { document } = trimToPage(before);
    for (const key of ['skills', 'education'] as const) {
      assert.deepEqual(
        document.sections.find((s) => s.key === key),
        before.sections.find((s) => s.key === key),
      );
    }
  });

  test('a role always keeps at least two bullets', () => {
    const { document } = trimToPage(longDocument({ projects: 14 }));
    const exp = document.sections.find((s) => s.key === 'experience');
    for (const g of exp?.groups ?? []) assert.ok(g.items.length >= 2);
  });

  test('the input document is not mutated', () => {
    const doc = longDocument();
    const snapshot = JSON.stringify(doc);
    trimToPage(doc);
    assert.equal(JSON.stringify(doc), snapshot);
  });

  test('a document that already fits comes back unchanged', () => {
    const doc = longDocument({ projects: 2 });
    assert.notEqual(lengthVerdict(doc), 'long');
    const { document, removed } = trimToPage(doc);
    assert.equal(document, doc);
    assert.deepEqual(removed, []);
  });

  test('with no job there is no page budget, and nothing is removed', () => {
    const doc = { ...longDocument(), jobRequirement: null };
    assert.deepEqual(trimToPage(doc).removed, []);
  });

  test('it never trims a resume from too long into too short', () => {
    // Many one-word lines: long on line count, and one removal from short on words.
    const doc = longDocument({ projects: 12, wordsPerItem: 1 });
    assert.equal(lengthVerdict(doc), 'long');
    const { document } = trimToPage(doc);
    assert.notEqual(lengthVerdict(document), 'short');
  });
});
