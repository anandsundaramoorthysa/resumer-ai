/**
 * The rule that decides what the enrichment queue asks, and when it stops asking.
 *
 * Three properties are worth pinning, because getting any of them wrong turns a queue
 * people use into one they close:
 *
 *   1. A question is derived from a real signal and quotes the user's own words. A
 *      generic "add a metric" prompt already exists in spirit on this page and moved
 *      nothing; the value here is entirely in being specific about one line.
 *   2. It is asked once. The same bullet is flagged by the grounding check and the
 *      evidence grader on the same run, by three consecutive drafts, and every time the
 *      profile is re-read — and it is one question throughout.
 *   3. It disappears when the gap closes, however it closed, and never comes back after
 *      it is settled.
 *
 * Plus the two things that keep it honest: nothing a rewrite invented is ever repeated
 * back to the user, and the highest-impact question is the one on screen.
 */

import {
  IMPACT,
  MAX_NEW_QUESTIONS_PER_DRAFT,
  MAX_OPEN_QUESTIONS,
  rationPerKind,
  buildEnrichmentQuestions,
  deficienciesFrom,
  isGapOpen,
  keywordDemandBonus,
  missingBulletParts,
  orderQuestions,
  rationedSlice,
  QUESTIONS_SHOWN,
  recordIdForText,
  selectNewQuestions,
  type DraftedQuestion,
  type EnrichmentSignal,
} from '../lib/profile/enrichment';
import type {
  ExperienceBulletRecord,
  JobRequirement,
  ProfileRecord,
  ResumeDocument,
  RoleRecord,
} from '../lib/types';
import { suite, test, assert } from './harness.mjs';

/* --------------------------------------------------------------- fixtures -- */

const base = {
  userId: 'u1',
  source: 'manual' as const,
  flaggedForRemoval: false,
  reviewState: 'approved' as const,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

function bullet(
  id: string,
  roleId: string,
  text: string,
  parts: { scale?: string; outcome?: string } = {},
): ExperienceBulletRecord {
  return {
    ...base,
    id,
    type: 'experience-bullet',
    roleId,
    text,
    action: text,
    scale: parts.scale,
    outcome: parts.outcome,
    tags: [],
    contentHash: `h-${id}`,
  } as unknown as ExperienceBulletRecord;
}

function project(id: string, name: string, metrics: string[] = []): ProfileRecord {
  return {
    ...base,
    id,
    type: 'project',
    name,
    description: 'An internal tool.',
    stack: ['TypeScript', 'PostgreSQL'],
    links: [],
    impactMetrics: metrics,
    tags: [],
    contentHash: `h-${id}`,
  } as unknown as ProfileRecord;
}

function skill(id: string, name: string): ProfileRecord {
  return {
    ...base,
    id,
    type: 'skill',
    name,
    category: 'tool',
    tags: [name.toLowerCase()],
    contentHash: `h-${id}`,
  } as unknown as ProfileRecord;
}

const CURRENT: RoleRecord = {
  id: 'r-now',
  userId: 'u1',
  title: 'Platform Engineer',
  company: 'Northwind',
  startDate: '2021-03',
  endDate: 'present',
  source: 'manual',
  contentHash: 'rh1',
  reviewState: 'approved',
};

const OLD: RoleRecord = {
  id: 'r-old',
  userId: 'u1',
  title: 'Intern',
  company: 'Acme',
  startDate: '2019-01',
  endDate: '2019-08',
  source: 'manual',
  contentHash: 'rh2',
  reviewState: 'approved',
};

const JOB: JobRequirement = {
  roleTitle: 'Technical SEO Lead',
  company: 'Semrush',
  seniority: 'senior',
  category: 'seo',
  requiredSkills: ['Screaming Frog', 'Google Analytics 4'],
  preferredSkills: [],
  responsibilities: [],
  atsKeywords: ['Screaming Frog', 'Google Analytics 4', 'schema markup'],
  tone: 'neutral',
  confidence: 0.9,
  flags: [],
};

/** A document whose items point back at the records above, the way assembly builds it. */
function documentFor(
  items: Array<{ section: 'experience' | 'projects'; text: string; recordId: string }>,
): ResumeDocument {
  const sections = ['experience', 'projects'].map((key) => ({
    key: key as 'experience' | 'projects',
    heading: key,
    items: [],
    groups: [
      {
        title: key === 'experience' ? 'Platform Engineer' : 'Tidewater',
        items: items
          .filter((i) => i.section === key)
          .map((i) => ({ text: i.text, sourceRecordId: i.recordId })),
      },
    ],
  }));
  return {
    id: 'doc1',
    userId: 'u1',
    contact: { fullName: 'A', email: 'a@b.c' },
    sections,
    jobRequirement: JOB,
    renderMode: 'ats-strict',
    recordHashSnapshot: [],
    createdAt: new Date(),
  } as unknown as ResumeDocument;
}

function emptySignal(): EnrichmentSignal {
  return {
    rejectedRewrites: [],
    weakBullets: [],
    genuineGaps: [],
    document: null,
    job: JOB,
  };
}

/* ------------------------------------------------------------------ tests -- */

suite('enrichment — questions come from the real signal', () => {
  const b = bullet('b1', CURRENT.id, 'Optimized the checkout service.');
  const records = [b];

  test('a refused rewrite becomes a question quoting the user own bullet', () => {
    const qs = buildEnrichmentQuestions(
      { ...emptySignal(), rejectedRewrites: [{ recordId: 'b1', text: b.text }] },
      records,
      [CURRENT],
    );
    assert.equal(qs.length, 1);
    assert.equal(qs[0].kind, 'bullet');
    assert.equal(qs[0].recordId, 'b1');
    assert.equal(qs[0].quote, 'Optimized the checkout service.');
    assert.equal(qs[0].context, 'Platform Engineer — Northwind');
  });

  test('the question never repeats the figure the rewrite wanted to invent', () => {
    // The signal deliberately carries only the SOURCE text, never the candidate. This
    // asserts the contract at the point it would be easiest to break: a reason line
    // that quoted the rejected rewrite would hand the user a number to agree with, and
    // every later grounding check would then verify against a figure a model chose.
    const qs = buildEnrichmentQuestions(
      { ...emptySignal(), rejectedRewrites: [{ recordId: 'b1', text: b.text }] },
      records,
      [CURRENT],
    );
    assert.equal(/\d/.test(qs[0].reason), false);
    assert.equal(/\d/.test(qs[0].quote), false);
  });

  test('a weak bullet carries the grader own words as the reason', () => {
    const doc = documentFor([
      { section: 'experience', text: b.text, recordId: 'b1' },
    ]);
    const qs = buildEnrichmentQuestions(
      {
        ...emptySignal(),
        document: doc,
        weakBullets: [
          {
            sectionKey: 'experience',
            itemIndex: 0,
            text: b.text,
            problem: 'names a service but shows no scale and no measurable outcome',
          },
        ],
      },
      records,
      [CURRENT],
    );
    assert.equal(qs.length, 1);
    assert.match(qs[0].reason, /no scale and no measurable outcome/);
  });

  test('a genuine keyword gap becomes a question naming the posting', () => {
    const qs = buildEnrichmentQuestions(
      { ...emptySignal(), genuineGaps: ['Screaming Frog'] },
      records,
      [CURRENT],
    );
    assert.equal(qs.length, 1);
    assert.equal(qs[0].kind, 'skill');
    assert.equal(qs[0].recordId, null);
    assert.equal(qs[0].topic, 'Screaming Frog');
    assert.match(qs[0].reason, /Technical SEO Lead/);
  });

  test('the posting own title and employer are never asked about as skills', () => {
    // Both arrive in `genuineGaps` because the profile genuinely cannot evidence them,
    // which is correct for the halt message and absurd as a question.
    const qs = buildEnrichmentQuestions(
      {
        ...emptySignal(),
        genuineGaps: ['Technical SEO Lead', 'Semrush', 'Screaming Frog'],
      },
      records,
      [CURRENT],
    );
    assert.deepEqual(
      qs.map((q) => q.topic),
      ['Screaming Frog'],
    );
  });

  test('a project with no measurable outcome is asked about, one with a number is not', () => {
    const thin = project('p1', 'Tidewater');
    const measured = project('p2', 'Harbour', ['cut build time 40%']);
    const doc = documentFor([
      { section: 'projects', text: 'An internal tool.', recordId: 'p1' },
      { section: 'projects', text: 'Another tool.', recordId: 'p2' },
    ]);
    const qs = buildEnrichmentQuestions(
      {
        ...emptySignal(),
        document: doc,
        weakBullets: [
          { sectionKey: 'projects', itemIndex: 0, text: 'An internal tool.', problem: 'no result' },
          { sectionKey: 'projects', itemIndex: 1, text: 'Another tool.', problem: 'no result' },
        ],
      },
      [thin, measured],
      [],
    );
    assert.deepEqual(
      qs.map((q) => q.recordId),
      ['p1'],
    );
  });

  test('a bullet that already states both halves is never asked about', () => {
    const complete = bullet('b9', CURRENT.id, 'Did a thing 40% faster for 200 users.', {
      scale: 'for 200 users',
      outcome: '40% faster',
    });
    const qs = buildEnrichmentQuestions(
      { ...emptySignal(), rejectedRewrites: [{ recordId: 'b9', text: complete.text as string }] },
      [complete],
      [CURRENT],
    );
    assert.equal(qs.length, 0);
  });
});

suite('enrichment — one question per subject', () => {
  const b = bullet('b1', CURRENT.id, 'Optimized the checkout service.');

  test('two signals on the same bullet produce one question at the higher impact', () => {
    const doc = documentFor([
      { section: 'experience', text: b.text, recordId: 'b1' },
    ]);
    const qs = buildEnrichmentQuestions(
      {
        ...emptySignal(),
        document: doc,
        rejectedRewrites: [{ recordId: 'b1', text: b.text }],
        weakBullets: [
          {
            sectionKey: 'experience',
            itemIndex: 0,
            text: b.text,
            problem: 'no scale, no outcome',
          },
        ],
      },
      [b],
      [CURRENT],
    );
    assert.equal(qs.length, 1);
    // The refused rewrite outbids the grader's flag, so its reason is the one shown.
    assert.match(qs[0].reason, /tried to strengthen this line/);
  });

  test('a subject already in the queue is not queued again, in any state', () => {
    const drafted: DraftedQuestion[] = [
      { subjectKey: 'bullet:b1', kind: 'bullet', recordId: 'b1', topic: '', quote: 'q', context: '', reason: '', priority: 70 },
      { subjectKey: 'skill:terraform', kind: 'skill', recordId: null, topic: 'Terraform', quote: 'Terraform', context: '', reason: '', priority: 100 },
    ];
    // 'bullet:b1' is a settled tombstone — answered or skipped, it is never re-asked.
    const fresh = selectNewQuestions(drafted, ['bullet:b1'], 0);
    assert.deepEqual(
      fresh.map((q) => q.subjectKey),
      ['skill:terraform'],
    );
  });

  test('the same gap seen by three drafts stays one row', () => {
    const drafted: DraftedQuestion[] = [
      { subjectKey: 'bullet:b1', kind: 'bullet', recordId: 'b1', topic: '', quote: 'q', context: '', reason: '', priority: 70 },
    ];
    let queued: string[] = [];
    for (let draft = 0; draft < 3; draft++) {
      const fresh = selectNewQuestions(drafted, queued, queued.length);
      queued = [...queued, ...fresh.map((q) => q.subjectKey)];
    }
    assert.deepEqual(queued, ['bullet:b1']);
  });
});

suite('enrichment — ordering puts the highest impact first', () => {
  test('a keyword the posting demands outranks everything else', () => {
    const b = bullet('b1', CURRENT.id, 'Optimized the checkout service.');
    const p = project('p1', 'Tidewater');
    const doc = documentFor([
      { section: 'experience', text: b.text, recordId: 'b1' },
      { section: 'projects', text: 'An internal tool.', recordId: 'p1' },
    ]);
    const qs = buildEnrichmentQuestions(
      {
        ...emptySignal(),
        document: doc,
        genuineGaps: ['Screaming Frog'],
        rejectedRewrites: [{ recordId: 'b1', text: b.text }],
        weakBullets: [
          { sectionKey: 'projects', itemIndex: 0, text: 'An internal tool.', problem: 'no result' },
        ],
      },
      [b, p],
      [CURRENT],
    );
    assert.deepEqual(
      qs.map((q) => q.kind),
      ['skill', 'bullet', 'project'],
    );
  });

  test('a skill named first in the posting outranks one named last', () => {
    assert.ok(
      keywordDemandBonus(JOB, 'Screaming Frog') > keywordDemandBonus(JOB, 'schema markup'),
    );
    assert.equal(keywordDemandBonus(JOB, 'Kubernetes'), 0);
  });

  test('a bullet on the current job outranks the same bullet on an old one', () => {
    const now = bullet('b-now', CURRENT.id, 'Shipped the thing.');
    const then = bullet('b-old', OLD.id, 'Shipped another thing.');
    const qs = buildEnrichmentQuestions(
      {
        ...emptySignal(),
        rejectedRewrites: [
          { recordId: 'b-old', text: then.text as string },
          { recordId: 'b-now', text: now.text as string },
        ],
      },
      [now, then],
      [CURRENT, OLD],
    );
    assert.deepEqual(
      qs.map((q) => q.recordId),
      ['b-now', 'b-old'],
    );
  });

  test('equal impact sorts stably, so the list does not shuffle between renders', () => {
    const items = [
      { subjectKey: 'bullet:b', priority: 50 },
      { subjectKey: 'bullet:a', priority: 50 },
      { subjectKey: 'bullet:c', priority: 50 },
    ];
    assert.deepEqual(
      orderQuestions(items).map((i) => i.subjectKey),
      ['bullet:a', 'bullet:b', 'bullet:c'],
    );
    assert.deepEqual(orderQuestions(items), orderQuestions([...items].reverse()));
  });

  test('the impact table keeps its documented order', () => {
    assert.ok(IMPACT.skillGap > IMPACT.rejectedRewrite);
    assert.ok(IMPACT.rejectedRewrite > IMPACT.weakBoth);
    assert.ok(IMPACT.weakBoth > IMPACT.weakOne);
    assert.ok(IMPACT.weakOne > IMPACT.projectNoOutcome);
    // A recency or demand bonus must never lift one tier above the next.
    assert.ok(IMPACT.rejectedRewrite + 5 < IMPACT.skillGap);
  });
});

suite('enrichment — volume is capped', () => {
  const many: DraftedQuestion[] = Array.from({ length: 30 }, (_, i) => ({
    subjectKey: `bullet:b${i}`,
    kind: 'bullet' as const,
    recordId: `b${i}`,
    topic: '',
    quote: 'q',
    context: '',
    reason: '',
    priority: 100 - i,
  }));

  test('one draft may add no more than the per-draft cap', () => {
    assert.equal(selectNewQuestions(many, [], 0).length, MAX_NEW_QUESTIONS_PER_DRAFT);
  });

  test('it adds the highest-impact ones, not the first ones it happened to build', () => {
    const shuffled = [...many].reverse();
    assert.deepEqual(
      selectNewQuestions(shuffled, [], 0).map((q) => q.subjectKey),
      many.slice(0, MAX_NEW_QUESTIONS_PER_DRAFT).map((q) => q.subjectKey),
    );
  });

  test('a full backlog stops growing', () => {
    assert.equal(selectNewQuestions(many, [], MAX_OPEN_QUESTIONS).length, 0);
    assert.equal(selectNewQuestions(many, [], MAX_OPEN_QUESTIONS - 2).length, 2);
  });

  test('one kind of signal cannot own the whole intake — the observed regression', () => {
    /*
     * The first real run of this against a thin profile produced fifteen keyword gaps,
     * one refused rewrite and an evidence sub-score of zero. Because a keyword gap
     * correctly outranks everything, all six slots went to keyword gaps: the queue never
     * once quoted a line the user had written, and answering all of it could not have
     * moved the evidence score at all.
     */
    const gaps: DraftedQuestion[] = Array.from({ length: 15 }, (_, i) => ({
      subjectKey: `skill:k${i}`,
      kind: 'skill' as const,
      recordId: null,
      topic: `K${i}`,
      quote: `K${i}`,
      context: '',
      reason: '',
      priority: 120 - i,
    }));
    const bullets: DraftedQuestion[] = Array.from({ length: 2 }, (_, i) => ({
      subjectKey: `bullet:b${i}`,
      kind: 'bullet' as const,
      recordId: `b${i}`,
      topic: '',
      quote: 'Ran technical SEO audits.',
      context: '',
      reason: '',
      priority: 70 - i,
    }));

    const fresh = selectNewQuestions([...gaps, ...bullets], [], 0);
    assert.equal(fresh.length, MAX_NEW_QUESTIONS_PER_DRAFT);
    assert.equal(fresh.filter((q) => q.kind === 'skill').length, 4);
    assert.equal(fresh.filter((q) => q.kind === 'bullet').length, 2);
    // The highest-priority gap is still first: rationing changes the mix, not the order.
    assert.equal(fresh[0].subjectKey, 'skill:k0');
  });

  test('rationing does not under-fill when a draft found only one kind', () => {
    // The cap is a share of a contested allowance, not a quota. With nothing to share
    // with, the best six still go in.
    const fresh = selectNewQuestions(many, [], 0);
    assert.equal(fresh.length, MAX_NEW_QUESTIONS_PER_DRAFT);
    assert.equal(fresh.filter((q) => q.kind === 'bullet').length, MAX_NEW_QUESTIONS_PER_DRAFT);
  });

  test('the first-pass ration is half of whatever is being spent', () => {
    assert.equal(rationPerKind(MAX_NEW_QUESTIONS_PER_DRAFT), 3);
    // The same rule sizes the on-screen list, so three slots span two kinds.
    assert.equal(rationPerKind(QUESTIONS_SHOWN), 2);
  });

  test('the on-screen list is rationed too — the second half of the regression', () => {
    const mixed = [
      ...Array.from({ length: 5 }, (_, i) => ({
        kind: 'skill' as const,
        subjectKey: 'skill:k' + i,
        priority: 120 - i,
      })),
      { kind: 'bullet' as const, subjectKey: 'bullet:b0', priority: 74 },
      { kind: 'project' as const, subjectKey: 'project:p0', priority: 30 },
    ];
    const shown = rationedSlice(mixed, QUESTIONS_SHOWN);
    assert.equal(shown.length, QUESTIONS_SHOWN);
    assert.equal(shown.filter((q) => q.kind === 'skill').length, 2);
    assert.equal(shown.filter((q) => q.kind === 'bullet').length, 1);
    assert.equal(shown[0].subjectKey, 'skill:k0');
  });
});

suite('enrichment — a question disappears when its gap closes', () => {
  test('a bullet question closes once both halves are stated', () => {
    const half = bullet('b1', CURRENT.id, 'Did a thing for 200 users.', { scale: 'for 200 users' });
    const whole = bullet('b1', CURRENT.id, 'Did a thing for 200 users, 40% faster.', {
      scale: 'for 200 users',
      outcome: '40% faster',
    });
    const q = { kind: 'bullet' as const, recordId: 'b1', topic: '' };
    assert.equal(isGapOpen(q, [half]), true);
    assert.deepEqual(missingBulletParts(half), ['outcome']);
    assert.equal(isGapOpen(q, [whole]), false);
    assert.deepEqual(missingBulletParts(whole), []);
  });

  test('a project question closes on a measurable outcome, not on any prose', () => {
    const q = { kind: 'project' as const, recordId: 'p1', topic: '' };
    assert.equal(isGapOpen(q, [project('p1', 'Tidewater')]), true);
    // No figure in it, so it is not an outcome — the same rule lib/profile/gaps.ts uses.
    assert.equal(isGapOpen(q, [project('p1', 'Tidewater', ['people liked it'])]), true);
    assert.equal(isGapOpen(q, [project('p1', 'Tidewater', ['cut build time 40%'])]), false);
  });

  test('a skill question closes when the profile can evidence the keyword', () => {
    const q = { kind: 'skill' as const, recordId: null, topic: 'Kubernetes' };
    assert.equal(isGapOpen(q, [skill('s1', 'PostgreSQL')]), true);
    assert.equal(isGapOpen(q, [skill('s2', 'Kubernetes')]), false);
    // Through the alias table too, so "K8s" is not asked for twice.
    assert.equal(isGapOpen(q, [skill('s3', 'K8s')]), false);
  });

  test('a deleted or flagged record takes its question with it', () => {
    const q = { kind: 'bullet' as const, recordId: 'b1', topic: '' };
    assert.equal(isGapOpen(q, []), false);
    const flagged = { ...bullet('b1', CURRENT.id, 'x'), flaggedForRemoval: true } as ProfileRecord;
    assert.equal(isGapOpen(q, [flagged]), false);
  });
});

suite('enrichment — reading the signal', () => {
  test('the grader problem string maps onto the dimension it names', () => {
    assert.deepEqual(deficienciesFrom('no scale given'), ['scale']);
    assert.deepEqual(deficienciesFrom('states no measurable outcome'), ['outcome']);
    assert.deepEqual(deficienciesFrom('no scale and no result'), ['scale', 'outcome']);
    // Unrecognised wording means "nothing specific here", so both are asked for.
    assert.deepEqual(deficienciesFrom('vague'), ['scale', 'outcome']);
    assert.deepEqual(deficienciesFrom(''), ['scale', 'outcome']);
  });

  test('a printed line is traced back to its record through the document', () => {
    const doc = documentFor([
      { section: 'experience', text: 'Shipped the thing.', recordId: 'b1' },
      { section: 'projects', text: 'An internal tool.', recordId: 'p1' },
    ]);
    assert.equal(recordIdForText(doc, 'Shipped the thing.'), 'b1');
    assert.equal(recordIdForText(doc, '  An internal tool.  '), 'p1');
    assert.equal(recordIdForText(doc, 'Never printed.'), null);
    assert.equal(recordIdForText(null, 'Shipped the thing.'), null);
  });

  test('a weak bullet the document cannot place is dropped, not guessed at', () => {
    const b = bullet('b1', CURRENT.id, 'Shipped the thing.');
    const qs = buildEnrichmentQuestions(
      {
        ...emptySignal(),
        document: documentFor([]),
        weakBullets: [
          { sectionKey: 'experience', itemIndex: 0, text: 'Something else.', problem: 'no scale' },
        ],
      },
      [b],
      [CURRENT],
    );
    assert.equal(qs.length, 0);
  });

  test('the summary section is never asked about — it has no scale to state', () => {
    const b = bullet('b1', CURRENT.id, 'Shipped the thing.');
    const qs = buildEnrichmentQuestions(
      {
        ...emptySignal(),
        document: documentFor([
          { section: 'experience', text: 'Shipped the thing.', recordId: 'b1' },
        ]),
        weakBullets: [
          { sectionKey: 'summary', itemIndex: 0, text: 'Shipped the thing.', problem: 'no scale' },
        ],
      },
      [b],
      [CURRENT],
    );
    assert.equal(qs.length, 0);
  });
});
