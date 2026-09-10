/**
 * Swapping in a project the posting would recognise — lib/generate/revise.ts.
 *
 * On the EA analytics posting the profile held a project that mentions regression, a term
 * the posting asks for, and retrieval did not pick it: the gate counted "regression"
 * missing on a resume whose owner has it. The revision pass may now swap such a project
 * in. The ways that could go wrong are the ones pinned: swapping when nothing is gained,
 * swapping away the only place another term appeared, and rendering the incoming project
 * differently from the way the assembler renders its neighbours.
 */

import { assert, report, testAsync, suiteAsync } from './harness.mjs';
import { reviseDocument } from '@/lib/generate/revise';
import { assembleResume } from '@/lib/generate/assemble';
import { scoreKeywordCoverage } from '@/lib/quality/keywords';
import type {
  Critique,
  JobRequirement,
  ProfileRecord,
  ProjectRecord,
  ResumeDocument,
} from '@/lib/types';

const job: JobRequirement = {
  roleTitle: 'Analyst Intern',
  seniority: 'intern',
  category: 'data',
  requiredSkills: [],
  preferredSkills: [],
  responsibilities: [],
  atsKeywords: ['Python', 'regression'],
  tone: 'neutral',
  confidence: 1,
  flags: [],
};

const base = {
  userId: 'u1',
  source: 'manual' as const,
  flaggedForRemoval: false,
  reviewState: 'approved' as const,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

function project(id: string, name: string, description: string, stack: string[] = []): ProjectRecord {
  // No tags on purpose: the Skills fix reads tags and stacks, and this is the case it
  // cannot reach — a term that lives only in a project's description.
  return { ...base, id, type: 'project', name, description, stack, links: [], impactMetrics: [], tags: [], contentHash: `hash-${id}` };
}

const chat = project('p1', 'Chat App', 'A messaging app', ['Flutter']);
const site = project('p2', 'Portfolio site', 'Personal site');
const churn = project('p3', 'Churn model', 'Trained a logistic regression model to predict churn', ['scikit-learn']);

function document(groups: ProjectRecord[]): ResumeDocument {
  return {
    id: 'd1',
    userId: 'u1',
    contact: { fullName: 'A Candidate', email: 'a@example.com' },
    sections: [
      { key: 'skills', heading: 'Skills', items: [{ text: 'Python', sourceRecordId: null }] },
      {
        key: 'projects',
        heading: 'Projects',
        items: [],
        groups: groups.map((p) => ({
          title: p.name,
          subtitle: p.stack.slice(0, 6).join(', '),
          items: p.description ? [{ text: p.description, sourceRecordId: p.id }] : [],
        })),
      },
    ],
    jobRequirement: job,
    renderMode: 'ats-strict',
    recordHashSnapshot: groups.map((p) => p.contentHash),
    createdAt: new Date('2024-01-01'),
  };
}

const keywordCritique = (missing: string): Critique => ({
  subScore: 'keywords',
  message: `Keyword coverage is 50% — below the 70% gate. Missing: ${missing}.`,
});

const titles = (doc: ResumeDocument) =>
  doc.sections.find((s) => s.key === 'projects')?.groups?.map((g) => g.title) ?? [];

await suiteAsync('revision — swapping in a project the posting recognises', async () => {
  await testAsync('an unused project carrying a missing term replaces one carrying none', async () => {
    const records: ProfileRecord[] = [chat, site, churn];
    const out = await reviseDocument(document([chat, site]), [keywordCritique('regression')], records);

    assert.equal(out.changed, true);
    assert.ok(titles(out.document).includes('Churn model'));
    assert.equal(scoreKeywordCoverage(out.document).coveragePct, 1);
  });

  await testAsync('the later of two equally weak projects is the one replaced', async () => {
    const out = await reviseDocument(document([chat, site]), [keywordCritique('regression')], [chat, site, churn]);
    assert.deepEqual(titles(out.document), ['Chat App', 'Churn model']);
  });

  await testAsync('the snapshot’s source list follows what is printed (REQ-9.2)', async () => {
    const out = await reviseDocument(document([chat, site]), [keywordCritique('regression')], [chat, site, churn]);
    assert.ok(out.document.recordHashSnapshot.includes('hash-p3'));
    assert.ok(!out.document.recordHashSnapshot.includes('hash-p2'));
  });

  await testAsync('nothing is swapped when no unused project carries a missing term', async () => {
    const dull = project('p4', 'Todo list', 'A small todo app');
    const out = await reviseDocument(document([chat, site]), [keywordCritique('regression')], [chat, site, dull]);
    assert.deepEqual(titles(out.document), ['Chat App', 'Portfolio site']);
  });

  await testAsync('a swap that would lose as much as it gains is refused', async () => {
    // Both projects on the page carry a term the posting wants, each the only place it
    // appears; replacing either to gain "regression" would lose another term.
    const jobTwo: JobRequirement = { ...job, atsKeywords: ['Python', 'regression', 'Flutter', 'portfolio'] };
    const doc = { ...document([chat, site]), jobRequirement: jobTwo };
    doc.sections[0].items[0].text = 'Python';
    const before = scoreKeywordCoverage(doc).matched.length;

    const out = await reviseDocument(doc, [keywordCritique('regression')], [chat, site, churn]);
    assert.ok(scoreKeywordCoverage(out.document).matched.length >= before);
    assert.deepEqual(titles(out.document), ['Chat App', 'Portfolio site']);
  });

  await testAsync('without a keyword critique, nothing is swapped', async () => {
    const out = await reviseDocument(document([chat, site]), [], [chat, site, churn]);
    assert.deepEqual(titles(out.document), ['Chat App', 'Portfolio site']);
  });

  await testAsync('a swapped-in project looks exactly like one the assembler printed', async () => {
    const swapped = await reviseDocument(document([chat, site]), [keywordCritique('regression')], [chat, site, churn]);
    const incoming = swapped.document.sections
      .find((s) => s.key === 'projects')!
      .groups!.find((g) => g.title === 'Churn model');

    const assembled = await assembleResume({
      userId: 'u1',
      contact: { fullName: 'A Candidate', email: 'a@example.com' },
      job,
      records: [churn],
      roles: [],
      rewrite: false,
    });
    const printed = assembled.document.sections
      .find((s) => s.key === 'projects')!
      .groups!.find((g) => g.title === 'Churn model');

    assert.deepEqual(incoming, printed);
  });
});

report('revise-swap');
