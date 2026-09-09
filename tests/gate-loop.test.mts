/**
 * When the quality gate gives up — REQ-5.4, REQ-5.5.
 *
 * The loop is allowed four iterations, and it used to take all four whatever happened.
 * `reviseDocument` returns a document even when it changed nothing, so on a thin profile
 * every deterministic sub-score came back bit-identical and iterations 2, 3 and 4 bought a
 * judge call and a revise call each in exchange for the number already in hand.
 *
 * These cases pin the two early stops and, just as importantly, pin that they do not fire
 * on a loop that is actually making progress. `revise` is injected, so no model is
 * involved; the document deliberately carries no experience, projects or summary section,
 * which is the path where `scoreEvidence` returns a fixed 1 without calling one either.
 */

import { assert, report, testAsync, suiteAsync } from './harness.mjs';
import { runQualityGate, MAX_ITERATIONS, type ReviseOutcome } from '@/lib/quality/loop';
import type { JobRequirement, ProfileRecord, ResumeDocument } from '@/lib/types';

/* ------------------------------------------------------------- fixtures ---- */

const job: JobRequirement = {
  roleTitle: 'Senior Full Stack Engineer',
  company: 'Acme',
  seniority: 'senior',
  category: 'full-stack',
  requiredSkills: ['React'],
  preferredSkills: [],
  responsibilities: ['ship features'],
  // Absent from the document, so the keyword gate fails and the loop can never pass on
  // its own — but present in the profile below, so these are not genuine gaps.
  atsKeywords: ['Kubernetes', 'Terraform'],
  tone: 'startup',
  confidence: 0.9,
  flags: [],
};

const recordBase = {
  userId: 'u1',
  source: 'manual' as const,
  flaggedForRemoval: false,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

/**
 * The profile genuinely holds every keyword the job asks for.
 *
 * That is what separates the two early stops from the halt the loop already had: with no
 * `genuineGaps` to report, a stop can only be explained by the loop having nothing left to
 * try, which is exactly `no-progress`. The gap case is covered on its own below.
 */
const records: ProfileRecord[] = [
  {
    ...recordBase, id: 's1', type: 'skill', name: 'React', category: 'framework',
    tags: ['react'], contentHash: 'h1',
  },
  {
    ...recordBase, id: 's2', type: 'skill', name: 'Kubernetes', category: 'platform',
    tags: ['kubernetes'], contentHash: 'h2',
  },
  {
    ...recordBase, id: 's3', type: 'skill', name: 'Terraform', category: 'tool',
    tags: ['terraform'], contentHash: 'h3',
  },
];

/** Nothing in the profile evidences these, so they are real gaps (REQ-5.5). */
const jobWithGaps: JobRequirement = {
  ...job,
  atsKeywords: ['Erlang', 'Mainframe COBOL'],
};

function thinDocument(skills = 'React'): ResumeDocument {
  return {
    id: 'd1',
    userId: 'u1',
    contact: { fullName: 'A Candidate', email: 'a@example.com' },
    sections: [
      { key: 'skills', heading: 'Skills', items: [{ text: skills, sourceRecordId: null }] },
    ],
    jobRequirement: job,
    renderMode: 'ats-strict',
    recordHashSnapshot: [],
    createdAt: new Date('2024-01-01'),
  };
}

/** A revise that reports honestly that it did nothing. */
const didNothing = async (doc: ResumeDocument): Promise<ReviseOutcome> => ({
  document: doc,
  changed: false,
  unimprovable: [],
});

/** A revise that edits the document every time but never improves the score. */
function busywork(): { fn: (d: ResumeDocument) => Promise<ReviseOutcome>; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    fn: async (doc: ResumeDocument) => {
      n += 1;
      const next = structuredClone(doc);
      // A real edit that no scorer rewards: it adds no job keyword and no evidence.
      next.sections[0].items[0].text = `${next.sections[0].items[0].text}, Filler${n}`;
      return { document: next, changed: true, unimprovable: [] };
    },
  };
}

/* ---------------------------------------------------------------- cases ---- */

await suiteAsync('quality gate — stopping when nothing can change', async () => {
  await testAsync('a revision that changed nothing stops the loop immediately', async () => {
    let revisions = 0;
    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      revise: async (doc) => {
        revisions += 1;
        return didNothing(doc);
      },
    });

    assert.equal(outcome.result.iterations, 1, 'should not score a second time');
    assert.equal(revisions, 1, 'should not ask for a second revision');
    assert.equal(outcome.result.haltReason, 'no-progress');
  });

  await testAsync('the halt says why, and does not claim it ran out of attempts', async () => {
    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      revise: didNothing,
    });

    const why = outcome.result.haltExplanation ?? '';
    assert.match(why, /identical/i);
    assert.doesNotMatch(why, new RegExp(`after ${MAX_ITERATIONS} attempts`));
  });

  await testAsync('a document that keeps changing but never improves stops early too', async () => {
    const revise = busywork();
    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      revise: revise.fn,
    });

    assert.ok(
      outcome.result.iterations < MAX_ITERATIONS,
      `expected fewer than ${MAX_ITERATIONS} iterations, ran ${outcome.result.iterations}`,
    );
    assert.equal(outcome.result.haltReason, 'no-progress');
  });

  await testAsync('the best version is still what comes back', async () => {
    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      revise: didNothing,
    });

    assert.ok(outcome.document, 'a document must always be returned');
    assert.equal(outcome.result.passed, false);
    assert.equal(outcome.history.length, outcome.result.iterations);
  });

  await testAsync('a loop that is improving is allowed to keep going', async () => {
    // Each pass adds a job keyword to the Skills line, which moves the keyword gate and
    // the skills sub-score for real. Nothing here may trip the no-progress stop.
    const wanted = ['Kubernetes', 'Terraform'];
    let n = 0;
    const outcome = await runQualityGate({
      document: thinDocument(),
      records,
      revise: async (doc) => {
        const next = structuredClone(doc);
        const add = wanted[n++];
        if (add) next.sections[0].items[0].text += `, ${add}`;
        return { document: next, changed: true, unimprovable: [] };
      },
    });

    assert.ok(
      outcome.result.iterations >= 3,
      `a improving loop should run on; ran ${outcome.result.iterations}`,
    );
    assert.equal(outcome.result.keywordGatePassed, true);
  });

  await testAsync('a real gap is still reported as a gap, not as no-progress', async () => {
    // The distinction the loop already drew is the more useful thing to tell someone, and
    // it is true whether it was discovered on iteration 1 or iteration 4.
    const doc = thinDocument();
    doc.jobRequirement = jobWithGaps;

    const outcome = await runQualityGate({ document: doc, records, revise: didNothing });

    assert.equal(outcome.result.haltReason, 'unfixable-gap');
    assert.ok(outcome.genuineGaps.length > 0);
    assert.equal(outcome.result.iterations, 1, 'it should still stop early');
  });

  await testAsync('unimprovable bullets are carried forward, not re-asked', async () => {
    // The document has no gradable bullets, so this checks the plumbing rather than the
    // model: whatever a revision reports as unimprovable must reach the next scoring pass.
    const seen: string[][] = [];
    await runQualityGate({
      document: thinDocument(),
      records,
      revise: async (doc) => {
        seen.push(['a bullet nothing can fix']);
        return {
          document: doc,
          changed: false,
          unimprovable: ['a bullet nothing can fix'],
        };
      },
    });

    assert.equal(seen.length, 1);
  });
});

report('gate-loop');
