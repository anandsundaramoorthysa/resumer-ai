/**
 * What retrieval counts as a match — REQ-4.2, REQ-4.3.
 *
 * `domainFit` and `keywordOverlap` both tested raw substring containment, so "React"
 * matched "reacts to webhook events" and "Go" matched "google". `quality/vocabulary.ts`
 * removed exactly that class of false positive from the scorer and exports `containsPhrase`
 * for it; retrieval did not use it, so the stage that decides which records reach the
 * resume was optimising for a looser definition of a match than the gate rewards.
 *
 * The pair of cases per rule is the point: a matcher that says no to everything would pass
 * the false-positive tests and be useless, so every one of them is paired with a genuine
 * match that must still be found.
 */

import { assert, report, suite, test } from './harness.mjs';
import { domainFit, rankRecords, recordText, selectTop } from '@/lib/retrieval/rank';
import type { ExperienceBulletRecord, JobRequirement, ProfileRecord } from '@/lib/types';

/* ------------------------------------------------------------- fixtures ---- */

const recordBase = {
  userId: 'u1',
  source: 'manual' as const,
  flaggedForRemoval: false,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

function bullet(id: string, text: string, tags: string[] = []): ExperienceBulletRecord {
  return {
    ...recordBase,
    id,
    type: 'experience-bullet',
    roleId: 'r1',
    text,
    action: text.split(' ')[0] ?? 'did',
    tags,
    contentHash: id,
  } as ExperienceBulletRecord;
}

function jobFor(keywords: string[], category: JobRequirement['category'] = 'general'): JobRequirement {
  return {
    roleTitle: 'Engineer',
    seniority: 'mid',
    category,
    requiredSkills: keywords,
    preferredSkills: [],
    responsibilities: [],
    atsKeywords: keywords,
    tone: 'neutral',
    confidence: 0.9,
    flags: [],
  };
}

/**
 * Which of the job's keywords this single record was credited with.
 *
 * Deduplicated because the scoring pool is atsKeywords + requiredSkills + preferredSkills
 * and a term listed in two of them is weighed twice by design — that is the required-skill
 * weighting, not a matching question, so it is not what these cases are about.
 */
function matchesFor(record: ProfileRecord, job: JobRequirement): string[] {
  const { ranked } = rankRecords([record], job);
  return [...new Set(ranked[0]?.matchedKeywords ?? [])];
}

/* ---------------------------------------------------------------- cases ---- */

suite('keyword overlap is matched on word boundaries', () => {
  test('"React" no longer matches "reacts to webhook events"', () => {
    const record = bullet('b1', 'Built a service that reacts to webhook events from Stripe');
    assert.deepEqual(matchesFor(record, jobFor(['React'])), []);
  });

  test('but a bullet that really says React still matches', () => {
    const record = bullet('b2', 'Rebuilt the checkout flow in React, cutting latency 40%');
    assert.deepEqual(matchesFor(record, jobFor(['React'])), ['React']);
  });

  test('a short keyword cannot match inside a longer word', () => {
    const record = bullet('b3', 'Ran google ads campaigns for the marketing team');
    assert.deepEqual(matchesFor(record, jobFor(['Go'])), []);
  });

  test('the same short keyword matches when it stands alone', () => {
    const record = bullet('b4', 'Wrote the ingestion service in Go and shipped it');
    assert.deepEqual(matchesFor(record, jobFor(['Go'])), ['Go']);
  });

  test('punctuation is still a boundary, so "Node.js" matches', () => {
    const record = bullet('b5', 'Maintained a Node.js API used by three teams');
    assert.deepEqual(matchesFor(record, jobFor(['Node.js'])), ['Node.js']);
  });

  test('a multi-word keyword matches as a phrase', () => {
    const record = bullet('b6', 'Owned core web vitals work with the platform team');
    assert.deepEqual(matchesFor(record, jobFor(['core web vitals'])), ['core web vitals']);
  });

  test('tags count as text, same as before', () => {
    const record = bullet('b7', 'Shipped the thing', ['kubernetes']);
    assert.deepEqual(matchesFor(record, jobFor(['Kubernetes'])), ['Kubernetes']);
  });
});

suite('the relevance floor uses the same definition', () => {
  test('an off-domain bullet scores zero domain fit', () => {
    const record = bullet('b8', 'Tuned JVM garbage collection on a trading system');
    assert.equal(domainFit(record, jobFor([], 'seo')), 0);
  });

  test('a genuinely on-domain bullet still scores above the floor', () => {
    const record = bullet('b9', 'Ran technical SEO audits and fixed crawl and indexation issues');
    assert.ok(domainFit(record, jobFor([], 'seo')) > 0);
  });

  test('a near-miss word does not buy domain credit', () => {
    // "conversion" is SEO vocabulary; "conversional" is not a word this should credit.
    const near = bullet('b10', 'Handled data conversions between two legacy formats');
    const real = bullet('b11', 'Improved conversion on the pricing page');
    assert.ok(domainFit(real, jobFor([], 'seo')) > domainFit(near, jobFor([], 'seo')));
  });
});

suite('ranking still produces a usable selection', () => {
  test('a stricter matcher does not empty the resume', () => {
    // The floor relaxes progressively when too few records survive, and that safety valve
    // has to keep working now that fewer records match in the first place.
    const records: ProfileRecord[] = [
      bullet('b12', 'Tuned JVM garbage collection on a trading system'),
      bullet('b13', 'Migrated a monolith to containers'),
      bullet('b14', 'Wrote the deployment runbook nobody had'),
      bullet('b15', 'Ran the on-call rotation for a year'),
    ];
    const { ranked } = rankRecords(records, jobFor(['Kubernetes'], 'seo'));
    assert.ok(ranked.length > 0, 'the floor must relax rather than delete the resume');
    assert.ok(selectTop(ranked).length > 0);
  });

  test('records that match rank above records that do not', () => {
    const hit = bullet('b16', 'Rebuilt the checkout flow in React');
    const miss = bullet('b17', 'Wrote the deployment runbook nobody had');
    const { ranked } = rankRecords([miss, hit], jobFor(['React']));
    assert.equal(ranked[0].record.id, 'b16');
  });

  test('recordText still gathers everything searchable', () => {
    const record = bullet('b18', 'Shipped the thing', ['kubernetes']);
    const text = recordText(record);
    assert.match(text, /kubernetes/);
    assert.match(text, /shipped the thing/);
  });
});

report('retrieval');
