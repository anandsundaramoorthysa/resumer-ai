/**
 * Resuming the quality loop across requests — lib/quality/loop.ts.
 *
 * On a 30-second host every draft stopped after one revision pass. The loop now saves
 * where it got to and a later request resumes it. What must hold across that seam:
 * the resumed run starts with the revision the earlier one never made (not a re-score),
 * it remembers what it already learned, a worse pass can never replace the saved
 * version, and the total number of passes stays bounded however many requests it takes.
 */

import { assert, report, testAsync, suiteAsync } from './harness.mjs';
import {
  runQualityGate,
  scoreDocument,
  MAX_TOTAL_ITERATIONS,
  type ReviseOutcome,
} from '@/lib/quality/loop';
import type {
  Critique,
  JobRequirement,
  ProfileRecord,
  QualityGateResult,
  ResumeDocument,
} from '@/lib/types';

const job: JobRequirement = {
  roleTitle: 'Senior Full Stack Engineer',
  company: 'Acme',
  seniority: 'senior',
  category: 'full-stack',
  requiredSkills: ['React'],
  preferredSkills: [],
  responsibilities: ['ship features'],
  atsKeywords: ['Kubernetes', 'Terraform'],
  tone: 'startup',
  confidence: 0.9,
  flags: [],
};

const recordBase = {
  userId: 'u1',
  source: 'manual' as const,
  flaggedForRemoval: false,
  reviewState: 'approved' as const,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const records: ProfileRecord[] = [
  { ...recordBase, id: 's1', type: 'skill', name: 'React', category: 'framework', tags: ['react'], contentHash: 'h1' },
  { ...recordBase, id: 's2', type: 'skill', name: 'Kubernetes', category: 'platform', tags: ['kubernetes'], contentHash: 'h2' },
  { ...recordBase, id: 's3', type: 'skill', name: 'Terraform', category: 'tool', tags: ['terraform'], contentHash: 'h3' },
];

function thinDocument(skills = 'React'): ResumeDocument {
  return {
    id: 'd1',
    userId: 'u1',
    contact: { fullName: 'A Candidate', email: 'a@example.com' },
    sections: [{ key: 'skills', heading: 'Skills', items: [{ text: skills, sourceRecordId: null }] }],
    jobRequirement: job,
    renderMode: 'ats-strict',
    recordHashSnapshot: [],
    createdAt: new Date('2024-01-01'),
  };
}

/** A result as a paused draft would have saved it. */
async function savedAfterOnePass(
  over: Partial<QualityGateResult> = {},
  iterations = 1,
): Promise<QualityGateResult> {
  const first = await scoreDocument(thinDocument(), records);
  const result: QualityGateResult = { ...first.result, iterations, ...over };
  result.loop = {
    iterations,
    history: [{ iteration: iterations, overall: result.overall, keywordGatePassed: result.keywordGatePassed }],
    unimprovable: ['a bullet an earlier request could not strengthen'],
    stagnant: 0,
    previousOverall: result.overall,
    genuineGaps: [],
    canContinue: true,
  };
  return result;
}

await suiteAsync('quality gate — resuming across requests', async () => {
  await testAsync('a resumed run starts with the revision, using the saved critiques', async () => {
    const saved = await savedAfterOnePass();
    let firstCritiques: Critique[] | null = null;
    const wanted = ['Kubernetes', 'Terraform'];
    let n = 0;

    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      resume: saved,
      revise: async (doc, critiques) => {
        firstCritiques ??= critiques;
        const next = structuredClone(doc);
        const add = wanted[n++];
        if (add) next.sections[0].items[0].text += `, ${add}`;
        return { document: next, changed: Boolean(add), unimprovable: [] };
      },
    });

    assert.equal(firstCritiques, saved.critiques, 'the saved breakdown, not a fresh score, came first');
    assert.equal(outcome.history[0].iteration, 1, 'the saved pass is kept in the history');
    assert.equal(outcome.history[1].iteration, 2, 'numbering carries on across the requests');
  });

  await testAsync('what an earlier request learned is carried forward', async () => {
    const saved = await savedAfterOnePass();
    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      resume: saved,
      revise: async (doc): Promise<ReviseOutcome> => ({ document: doc, changed: false, unimprovable: [] }),
    });
    assert.ok(
      outcome.result.loop?.unimprovable.includes('a bullet an earlier request could not strengthen'),
    );
  });

  await testAsync('a worse pass never replaces the saved version', async () => {
    // Saved as scoring higher than anything a revision here can reach.
    const saved = await savedAfterOnePass({ overall: 9.4, passed: false });
    const doc = thinDocument();
    let n = 0;

    const outcome = await runQualityGate({
      document: doc,
      records,
      resume: saved,
      revise: async (d) => {
        const next = structuredClone(d);
        next.sections[0].items[0].text += `, Filler${++n}`;
        return { document: next, changed: true, unimprovable: [] };
      },
    });

    assert.equal(outcome.document, doc, 'the saved document is still the best');
    assert.equal(outcome.result.overall, 9.4);
    assert.equal(outcome.result.loop?.canContinue, false, 'and the stall ends the loop');
  });

  await testAsync('the total cap holds however many requests it takes', async () => {
    const saved = await savedAfterOnePass({}, MAX_TOTAL_ITERATIONS - 1);
    let n = 0;

    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      resume: saved,
      revise: async (d) => {
        const next = structuredClone(d);
        next.sections[0].items[0].text += `, Filler${++n}`;
        return { document: next, changed: true, unimprovable: [] };
      },
    });

    assert.ok((outcome.result.loop?.iterations ?? 0) <= MAX_TOTAL_ITERATIONS);
    assert.equal(outcome.result.loop?.canContinue, false);
  });

  await testAsync('a fresh run’s result carries its loop state too', async () => {
    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      revise: async (doc): Promise<ReviseOutcome> => ({ document: doc, changed: false, unimprovable: [] }),
    });
    assert.ok(outcome.result.loop, 'every result must say where the loop got to');
    assert.equal(outcome.result.loop?.iterations, 1);
    assert.equal(outcome.result.loop?.canContinue, false, 'an identical revision leaves nothing to try');
  });

  await testAsync('a saved result that already passes is returned untouched', async () => {
    const saved = await savedAfterOnePass({ passed: true });
    let revised = false;
    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      resume: saved,
      revise: async (doc) => {
        revised = true;
        return { document: doc, changed: false, unimprovable: [] };
      },
    });
    assert.equal(revised, false);
    assert.equal(outcome.result.loop?.canContinue, false);
  });
});

report('gate-resume');
