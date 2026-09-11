/**
 * The steward's rules — lib/steward/rules.ts. Fixtures are the owner's real defects
 * (STEWARD.md §2.2), paired with the look-alikes that must never be touched.
 */

import { isDatesOnly, ruleSuggestions, skillKeys } from '../lib/steward/rules';
import type { StewardRecord, StewardRole } from '../lib/steward/types';
import { suite, test, assert } from './harness.mjs';

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
    }).filter((x) => x.kind === 'fix');
    assert.deepEqual(s.map((x) => x.title), ['Drop the description that repeats the title', 'Fix spacing and symbols', 'Write as “Segmentation”']);
    assert.ok(s.every((x) => x.quick));
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
