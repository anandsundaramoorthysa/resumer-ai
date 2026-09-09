/**
 * Size limits on the two model-filled schemas — REQ-3.3, REQ-2.3.
 *
 * Both schemas validated shape and not size, and size is what the rest of the pipeline
 * pays for: `retrieval/rank.ts` is O(records x keywords) and `quality/keywords.ts` rescans
 * the whole document per keyword on every gate iteration. A posting asking for 3,000
 * `atsKeywords` was a valid `JobRequirement`.
 *
 * A cap is only worth having if it never fires on real input, so each pair below checks
 * both ends: a realistically large but genuine value passes, and an absurd one is rejected.
 */

import { z } from 'zod';
import { assert, report, suite, test } from './harness.mjs';
import { JobSchema } from '@/lib/intake/extract';
import { ExtractionSchema } from '@/lib/sync/parse';

/* ------------------------------------------------------------- fixtures ---- */

function jobWith(overrides: Record<string, unknown>) {
  return {
    roleTitle: 'Senior Technical SEO Lead',
    company: 'Semrush',
    seniority: 'senior',
    category: 'seo',
    requiredSkills: ['Technical SEO', 'GA4'],
    preferredSkills: ['SQL'],
    responsibilities: ['Run site audits'],
    atsKeywords: ['technical seo', 'ga4', 'search console'],
    tone: 'corporate',
    inputQuality: 'rich',
    contradictions: [],
    ...overrides,
  };
}

function fill(n: number, value = 'keyword'): string[] {
  return Array.from({ length: n }, (_, i) => `${value}-${i}`);
}

function extractionWith(overrides: Record<string, unknown>) {
  return {
    skills: [{ name: 'React', category: 'framework' }],
    projects: [],
    experience: [],
    education: [],
    certifications: [],
    achievements: [],
    publications: [],
    writing: [],
    awards: [],
    languages: [],
    volunteering: [],
    interests: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------ JobSchema ---- */

suite('JobSchema — a posting cannot ask for an unbounded amount', () => {
  test('a normal posting still parses', () => {
    assert.equal(JobSchema.safeParse(jobWith({})).success, true);
  });

  test('a genuinely keyword-stuffed enterprise posting still parses', () => {
    // Real postings top out around 40-60 ATS terms; 120 is well past any observed one and
    // must still be accepted, because rejecting a real posting is the worse failure.
    assert.equal(
      JobSchema.safeParse(jobWith({ atsKeywords: fill(120) })).success,
      true,
    );
  });

  test('3,000 keywords is refused — the case that motivated the cap', () => {
    assert.equal(
      JobSchema.safeParse(jobWith({ atsKeywords: fill(3_000) })).success,
      false,
    );
  });

  test('a single keyword cannot be a paragraph', () => {
    assert.equal(
      JobSchema.safeParse(jobWith({ atsKeywords: ['x'.repeat(5_000)] })).success,
      false,
    );
  });

  test('an unbounded role title is refused — it reaches the cover letter', () => {
    assert.equal(
      JobSchema.safeParse(jobWith({ roleTitle: 'Engineer, '.repeat(500) })).success,
      false,
    );
  });

  test('a long but real role title is kept', () => {
    assert.equal(
      JobSchema.safeParse(
        jobWith({ roleTitle: 'Senior Kubernetes / Terraform / AWS Platform Engineer (Remote, EMEA)' }),
      ).success,
      true,
    );
  });

  test('required and preferred skills are bounded too', () => {
    assert.equal(JobSchema.safeParse(jobWith({ requiredSkills: fill(60) })).success, true);
    assert.equal(JobSchema.safeParse(jobWith({ requiredSkills: fill(900) })).success, false);
    assert.equal(JobSchema.safeParse(jobWith({ preferredSkills: fill(900) })).success, false);
  });

  test('responsibilities and contradictions are bounded too', () => {
    assert.equal(JobSchema.safeParse(jobWith({ responsibilities: fill(40) })).success, true);
    assert.equal(JobSchema.safeParse(jobWith({ responsibilities: fill(400) })).success, false);
    assert.equal(JobSchema.safeParse(jobWith({ contradictions: fill(200) })).success, false);
  });

  test('every array in the schema carries a maximum', () => {
    // A cap added to nine of ten arrays is the same hole with more code in front of it,
    // so this asserts the property rather than the list.
    const json = JSON.stringify(z.toJSONSchema(JobSchema));
    const arrays = countOccurrences(json, '"type":"array"');
    const maxItems = countOccurrences(json, '"maxItems"');
    assert.equal(maxItems, arrays, `${arrays} arrays but ${maxItems} maxItems`);
  });
});

/* ----------------------------------------------------- ExtractionSchema ---- */

suite('ExtractionSchema — repository content cannot ask for an unbounded amount', () => {
  test('a normal slice result still parses', () => {
    assert.equal(ExtractionSchema.safeParse(extractionWith({})).success, true);
  });

  test('a rich portfolio slice still parses', () => {
    const skills = fill(80, 'skill').map((name) => ({ name, category: 'tool' }));
    assert.equal(ExtractionSchema.safeParse(extractionWith({ skills })).success, true);
  });

  test('two thousand skills from one 3,500-character slice is refused', () => {
    const skills = fill(2_000, 'skill').map((name) => ({ name, category: 'tool' }));
    assert.equal(ExtractionSchema.safeParse(extractionWith({ skills })).success, false);
  });

  test('a project description cannot be a whole file', () => {
    const projects = [
      {
        name: 'Ledger',
        description: 'x'.repeat(50_000),
        stack: [],
        links: [],
        impactMetrics: [],
      },
    ];
    assert.equal(ExtractionSchema.safeParse(extractionWith({ projects })).success, false);
  });

  test('bullets inside a role are bounded, not just the roles', () => {
    const withBullets = (n: number) => [
      {
        company: 'Acme',
        title: 'Engineer',
        startDate: '2022-01',
        endDate: 'present',
        bullets: Array.from({ length: n }, (_, i) => ({
          text: `did thing ${i}`,
          action: 'did',
        })),
      },
    ];
    assert.equal(
      ExtractionSchema.safeParse(extractionWith({ experience: withBullets(20) })).success,
      true,
    );
    assert.equal(
      ExtractionSchema.safeParse(extractionWith({ experience: withBullets(500) })).success,
      false,
    );
  });

  test('the summary is bounded — it is copied verbatim onto the resume', () => {
    assert.equal(
      ExtractionSchema.safeParse(extractionWith({ summary: 'A short bio.' })).success,
      true,
    );
    assert.equal(
      ExtractionSchema.safeParse(extractionWith({ summary: 'x'.repeat(100_000) })).success,
      false,
    );
  });

  test('every array in the schema carries a maximum', () => {
    // The same conversion `chain.ts` makes for the text fallback, so this asserts what a
    // provider is actually told about the shape.
    const json = JSON.stringify(z.toJSONSchema(ExtractionSchema));
    const arrays = countOccurrences(json, '"type":"array"');
    const maxItems = countOccurrences(json, '"maxItems"');
    assert.equal(maxItems, arrays, `${arrays} arrays but ${maxItems} maxItems`);
  });
});

/* -------------------------------------------------------------- helpers ---- */

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

report('schema-bounds');
