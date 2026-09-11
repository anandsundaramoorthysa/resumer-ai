/**
 * The gate on the steward's model — lib/steward/verify.ts. A refusal that stops working
 * fails silently: the user simply sees a suggestion that invents something. So every
 * refusal is pinned here, with the proposal the live model actually made where it made one.
 */

import { verifyProposals, type AgentProposal } from '../lib/steward/verify';
import { ruleSuggestions } from '../lib/steward/rules';
import type { StewardRecord, StewardRole } from '../lib/steward/types';
import { suite, test, assert } from './harness.mjs';

const rec = (id: string, type: string, data: Record<string, unknown>): StewardRecord => ({
  id, type, source: 'github-sync', reviewState: 'approved', contentHash: `h-${id}`, data,
});
const role: StewardRole = { id: 'role1', title: 'Artificial Intelligence Intern', company: 'DiffuseAi', startDate: '2024-08', endDate: '2024-10', reviewState: 'approved' };
const p = (x: Partial<AgentProposal>): AgentProposal => ({
  recordId: '', action: 'rewrite', field: '', value: '', listValue: [], otherId: '', reason: 'because', ...x,
});

const bullet = rec('b1', 'experience-bullet', { roleId: 'role1', text: 'Worked on integrating AI models into web apps with Flask.', action: 'Worked on integrating AI models into web apps with Flask.' });
const project = rec('p1', 'project', { name: 'Internet Speed Finder', description: 'A simple Flask-based web tool to test your internet speed.', stack: ['Python', 'Flask', 'Speedtest', 'Climate Change'] });
const skills = [rec('s1', 'skill', { name: 'Data Science', category: 'framework' }), rec('s2', 'skill', { name: 'AI technologies', category: 'tool' }), rec('s3', 'skill', { name: 'RAG pipelines', category: 'tool' }), rec('s4', 'skill', { name: 'Retrieval-Augmented Generation (RAG)', category: 'framework' }), rec('s5', 'skill', { name: 'Docker', category: 'tool' })];
const records = [bullet, project, ...skills];
const run = (proposals: AgentProposal[]) => verifyProposals(proposals, records, [role]);

suite('steward gate — rewording', () => {
  test('a faithful rewording is kept', () => {
    const r = run([p({ recordId: 'b1', field: 'text', value: 'Integrated AI models into web apps with Flask.' })]);
    assert.equal(r.suggestions.length, 1);
    assert.equal(r.suggestions[0].changes?.text.to, 'Integrated AI models into web apps with Flask.');
  });

  test('an invented figure is refused', () => {
    const r = run([p({ recordId: 'b1', field: 'text', value: 'Integrated 12 AI models into web apps with Flask.' })]);
    assert.equal(r.suggestions.length, 0);
    assert.ok(r.refused[0].includes('introduces'));
  });

  test('an invented technology or employer is refused', () => {
    assert.equal(run([p({ recordId: 'b1', field: 'text', value: 'Integrated AI models into web apps with Django.' })]).suggestions.length, 0);
    assert.equal(run([p({ recordId: 'p1', field: 'description', value: 'A Flask web tool, built at Google, that tests internet speed.' })]).suggestions.length, 0);
  });

  test('first or second person may be removed but never added', () => {
    assert.equal(run([p({ recordId: 'p1', field: 'description', value: 'A Flask-based web tool that tests internet speed.' })]).suggestions.length, 1);
    assert.equal(run([p({ recordId: 'b1', field: 'text', value: 'I integrated AI models into web apps with Flask.' })]).suggestions.length, 0);
  });

  test('a rewording that balloons is refused', () => {
    const long = 'Integrated AI models into web apps with Flask, carefully and thoroughly, end to end, across every single part of the web apps and the Flask services behind them.';
    assert.equal(run([p({ recordId: 'b1', field: 'text', value: long })]).suggestions.length, 0);
  });

  test('a field the type does not allow is refused, and skills are never renamed', () => {
    assert.equal(run([p({ recordId: 'p1', field: 'name', value: 'Speed Finder' })]).suggestions.length, 0);
    assert.equal(run([p({ recordId: 's5', field: 'name', value: 'docker' })]).suggestions.length, 0);
  });

  test('a stack never loses a real skill, even when the model asks', () => {
    // The live model proposed dropping RAG from a chatbot's stack.
    const bot = rec('p2', 'project', { name: 'Botinigo', description: 'An admission chatbot.', stack: ['RAG', 'Next.js', 'Climate Change'] });
    const r = verifyProposals([p({ recordId: 'p2', field: 'stack', listValue: ['Next.js'] })], [bot], [role]);
    assert.equal(r.suggestions.length, 0);
    assert.ok(r.refused[0].includes('RAG'));
    const ok = verifyProposals([p({ recordId: 'p2', field: 'stack', listValue: ['RAG', 'Next.js'] })], [bot], [role]);
    assert.equal(ok.suggestions.length, 1);
  });

  test('a stack may lose a subject-matter entry but never gain one', () => {
    assert.equal(run([p({ recordId: 'p1', field: 'stack', listValue: ['Python', 'Flask', 'Speedtest'] })]).suggestions.length, 1);
    assert.equal(run([p({ recordId: 'p1', field: 'stack', listValue: ['Python', 'Flask', 'Django'] })]).suggestions.length, 0);
  });
});

suite('steward gate — skills, merges, moves', () => {
  test('a real keyword is never removed; filler may be', () => {
    // The live model proposed removing Data Science as "too vague".
    assert.equal(run([p({ recordId: 's1', action: 'remove' })]).suggestions.length, 0);
    assert.equal(run([p({ recordId: 's2', action: 'remove' })]).suggestions.length, 1);
  });

  test('a category must be one of the five and actually change', () => {
    assert.equal(run([p({ recordId: 's1', action: 'recategorize', value: 'tool' })]).suggestions.length, 1);
    assert.equal(run([p({ recordId: 's1', action: 'recategorize', value: 'discipline' })]).suggestions.length, 0);
    assert.equal(run([p({ recordId: 's5', action: 'recategorize', value: 'tool' })]).suggestions.length, 0);
  });

  test('a merge needs names that visibly share something', () => {
    const ok = run([p({ recordId: 's3', action: 'merge', otherId: 's4' })]);
    assert.equal(ok.suggestions[0].kind, 'merge');
    assert.deepEqual(ok.suggestions[0].removeIds, ['s3']);
    assert.equal(run([p({ recordId: 's5', action: 'merge', otherId: 's1' })]).suggestions.length, 0);
  });

  test('a move carries the new record and asks for what only the user knows', () => {
    const [s] = run([p({ recordId: 'p1', action: 'move', value: 'publication' })]).suggestions;
    assert.equal(s.moveTo?.type, 'publication');
    assert.equal(s.moveTo?.data.title, 'Internet Speed Finder');
    assert.equal(s.ask?.field, 'venue');
    assert.equal(run([p({ recordId: 'p1', action: 'move', value: 'skill' })]).suggestions.length, 0);
  });

  test('the model cannot act on a record it was not shown, or one the rules already handle', () => {
    assert.equal(run([p({ recordId: 'nope', field: 'text', value: 'x' })]).suggestions.length, 0);
    const taken = ruleSuggestions({ records: [rec('a1', 'achievement', { title: 'First Prize', description: 'First Prize' })], roles: [] });
    const r = verifyProposals([p({ recordId: 'a1', field: 'description', value: 'Won first prize.' })], [rec('a1', 'achievement', { title: 'First Prize', description: 'First Prize' })], [], taken);
    assert.equal(r.suggestions.length, 0);
  });
});
