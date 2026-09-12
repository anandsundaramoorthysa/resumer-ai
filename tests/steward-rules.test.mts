/**
 * The steward's rules — lib/steward/rules.ts. Fixtures are the owner's real defects
 * (STEWARD.md §2.2), paired with the look-alikes that must never be touched.
 */

import { isDatesOnly, ruleSuggestions, skillKeys } from '../lib/steward/rules';
import type { StewardRecord, StewardRole } from '../lib/steward/types';
import { suite, test, assert } from './harness.mjs';
import { duplicateRecords } from '@/lib/steward/duplicates';

let n = 0;
const rec = (type: string, data: Record<string, unknown>, extra: Partial<StewardRecord> = {}): StewardRecord => ({
  id: `r${++n}`,
  type,
  source: 'github-sync',
  reviewState: 'approved',
  contentHash: `h${n}`,
  data,
  ...extra,
});
const skill = (name: string, extra: Partial<StewardRecord> = {}) => rec('skill', { name, category: 'tool' }, extra);
const role: StewardRole = { id: 'role1', title: 'Freelancer', company: 'Self-employed', startDate: '2025-04', endDate: '2026-03', reviewState: 'approved' };
const role2: StewardRole = { id: 'role2', title: 'Project Manager', company: 'DiffuseAi', startDate: '2025-03', endDate: '2025-12', reviewState: 'approved' };
const bullet = (roleId: string, text: string) => rec('experience-bullet', { roleId, text, action: text });

suite('steward rules — duplicate skills', () => {
  const merges = (names: string[]) =>
    ruleSuggestions({ records: names.map((x) => skill(x)), roles: [] }).filter((s) => s.kind === 'merge');

  test('abbreviation, parenthetical acronym and plural are one skill', () => {
    const titles = merges(['ML', 'Machine Learning', 'NLP', 'Natural Language Processing (NLP)', 'LLM', 'LLMs', 'Large Language Models (LLM)']).map((m) => m.title);
    assert.deepEqual(titles, [
      'Merge “ML” into “Machine Learning”',
      'Merge “NLP” into “Natural Language Processing (NLP)”',
      'Merge “LLMs”, “LLM” into “Large Language Models (LLM)”',
    ]);
  });

  test('languages that differ by a symbol are never merged', () => {
    assert.equal(merges(['C', 'C++', 'C#']).length, 0);
    assert.ok(!skillKeys('C++').includes('c'));
  });

  test('the table spelling is kept: React over React.js', () => {
    assert.equal(merges(['React.js', 'React'])[0].title, 'Merge “React.js” into “React”');
  });

  test('related but different skills are left alone', () => {
    assert.equal(merges(['Java', 'JavaScript', 'Vector Search', 'Vector Databases', 'RAG pipelines', 'Git', 'GitHub']).length, 0);
  });
});

suite('steward rules — what kind of skill it is', () => {
  const filed = (name: string, category: string) =>
    ruleSuggestions({ records: [rec('skill', { name, category })], roles: [] }).filter((x) => x.kind === 'fix' && x.changes?.category);

  test('a technique filed as a library is re-filed as a method', () => {
    const [s] = filed('Machine Learning', 'framework');
    assert.equal(s.title, 'File under methods and disciplines');
    assert.equal(s.changes?.category.to, 'method');
    assert.equal(filed('Statistics', 'tool')[0].changes?.category.to, 'method');
    assert.equal(filed('Search Engine Optimization (SEO)', 'soft-skill')[0].changes?.category.to, 'method');
  });

  test("a certain re-filing is a quick fix; a guess from the shape of the name is not", () => {
    assert.equal(filed('Machine Learning', 'framework')[0].quick, true);
    assert.equal(filed('Zephyr Payments API', 'tool')[0].quick, false);
  });

  test('a real soft skill filed as technical is re-filed', () => {
    assert.equal(filed('Public Speaking', 'tool')[0].changes?.category.to, 'soft-skill');
  });

  test('anything already right, or not recognised, is left alone', () => {
    assert.equal(filed('Machine Learning', 'method').length, 0);
    assert.equal(filed('Docker', 'tool').length, 0);
    assert.equal(filed('Tally ERP', 'tool').length, 0);
    assert.equal(filed('Gemini API', 'platform').length, 0);
  });
});

suite('steward rules — bullets', () => {
  test('a bullet that only repeats the role dates is proposed for removal', () => {
    assert.ok(isDatesOnly('Freelanced through March 2026.', role));
    assert.ok(!isDatesOnly('Built 12 client websites through March 2026.', role));
    assert.ok(!isDatesOnly('Coordinated delivery across technical teams.', role));
  });

  test('a near-duplicate across roles drops the weaker telling', () => {
    const strong = bullet('role1', 'Integrated open-source AI models into web applications using Flask.');
    const weak = bullet('role2', 'Worked with open-source AI models and integrated them into web applications using Flask.');
    const s = ruleSuggestions({ records: [strong, weak], roles: [role, role2] }).filter((x) => x.kind === 'remove');
    assert.equal(s.length, 1);
    assert.equal(s[0].recordId, weak.id);
    assert.ok(s[0].reason.includes('Freelancer at Self-employed'));
  });

  test('two different achievements that share words are both kept', () => {
    const a = bullet('role1', 'Built a Flask API for the admissions chatbot.');
    const b = bullet('role1', 'Built a Next.js dashboard for tracking personal finance.');
    assert.equal(ruleSuggestions({ records: [a, b], roles: [role] }).filter((x) => x.kind === 'remove').length, 0);
  });
});

suite('steward rules — hygiene and asks', () => {
  test('existing typography and a title repeated as description are quick fixes', () => {
    const nbh = String.fromCharCode(0x2011);
    const s = ruleSuggestions({
      records: [
        rec('achievement', { title: 'First Prize', description: 'First Prize' }),
        bullet('role1', `Contributed to end${nbh}to${nbh}end web solutions.`),
        skill('segmentation'),
      ],
      roles: [role],
    }).filter((x) => x.kind === 'fix' && x.quick && !x.changes?.category);
    assert.deepEqual(s.map((x) => x.title), ['Drop the description that repeats the title', 'Fix spacing and symbols', 'Write as “Segmentation”']);
  });

  test('missing stack, certificate date and role bullets become questions', () => {
    const s = ruleSuggestions({
      records: [rec('project', { name: 'ChessToGIF', stack: [] }), rec('certification', { name: 'X', issuer: 'Y' })],
      roles: [role],
    }).filter((x) => x.kind === 'ask');
    assert.deepEqual(s.map((x) => x.ask?.field).sort(), ['bullet', 'issuedDate', 'stack']);
  });

  test('a suggestion id changes when the record changes, and not otherwise', () => {
    const r = skill('segmentation');
    const [a] = ruleSuggestions({ records: [r], roles: [] });
    const [b] = ruleSuggestions({ records: [r], roles: [] });
    const [c] = ruleSuggestions({ records: [{ ...r, contentHash: 'changed' }], roles: [] });
    assert.equal(a.id, b.id);
    assert.notEqual(a.id, c.id);
  });

  test('rejected records are ignored', () => {
    const s = ruleSuggestions({ records: [skill('ML', { reviewState: 'rejected' }), skill('Machine Learning')], roles: [] });
    assert.equal(s.filter((x) => x.kind === 'merge').length, 0);
  });
});

suite('the same fact stored twice, in any section', () => {
  const record = (over: Record<string, unknown>): StewardRecord =>
    ({ id: 'x', type: 'project', source: 'manual', reviewState: 'approved', contentHash: 'h', data: {}, ...over }) as StewardRecord;
  const label = (r: StewardRecord) => {
    const d = r.data as Record<string, unknown>;
    return String(d.name ?? d.title ?? '');
  };
  const run = (records: StewardRecord[]) => duplicateRecords(records, label, () => 'other');

  test('two projects with genuinely different names are two projects', () => {
    const out = run([
      record({ id: 'p1', contentHash: 'a', data: { name: 'ChessToGIF' } }),
      record({ id: 'p2', contentHash: 'b', data: { name: 'Tamil Lyrics Analysis' } }),
    ]);
    assert.equal(out.length, 0, 'nothing merged');
  });

  test('the same name punctuated differently is one project, and the fuller copy is kept', () => {
    const thin = record({ id: 'p1', contentHash: 'a', data: { name: 'ChessToGIF' }, source: 'github-sync' });
    const full = record({
      id: 'p2',
      contentHash: 'b',
      data: { name: 'chess to gif!', description: 'Renders a game as a GIF', impactMetrics: ['1,200 downloads'] },
    });
    const [s] = run([thin, full]);
    assert.ok(s, 'a duplicate is reported');
    assert.equal(s.recordId, 'p2', 'keeps the fuller copy');
    assert.deepEqual(s.removeIds, ['p1']);
    assert.deepEqual(Object.keys(s.basis).sort(), ['p1', 'p2'], 'both in the basis, so either changing invalidates it');
  });

  test('a certification from an import and the same one from the sync are one', () => {
    const out = run([
      record({ id: 'c1', type: 'certification', contentHash: 'a', data: { name: 'Google Data Analytics', issuer: 'Coursera' } }),
      record({ id: 'c2', type: 'certification', contentHash: 'b', data: { name: 'google data analytics ', issuer: 'coursera' } }),
    ]);
    assert.equal(out.length, 1, 'one merge proposed');
  });

  test('an award and an achievement of the same title are left alone by this rule', () => {
    const out = run([
      record({ id: 'a1', type: 'award', contentHash: 'a', data: { title: 'Smart India Hackathon Winner' } }),
      record({ id: 'a2', type: 'achievement', contentHash: 'b', data: { title: 'Smart India Hackathon Winner' } }),
    ]);
    assert.equal(out.length, 0, 'across types is a different question');
  });

  test('a rejected copy is not proposed for merging: it is already a no', () => {
    const out = run([
      record({ id: 'p1', contentHash: 'a', data: { name: 'Portfolio' } }),
      record({ id: 'p2', contentHash: 'b', data: { name: 'Portfolio' }, reviewState: 'rejected' }),
    ]);
    assert.equal(out.length, 0, 'nothing to merge');
  });
});
