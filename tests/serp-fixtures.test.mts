/**
 * Contract tests for fixtures/serpapi/*.json.
 *
 * The fixtures stand in for SerpApi in replay mode and in most radar tests. The normalisers
 * (lib/serp/normalize.ts) are deliberately forgiving — they skip a malformed entry rather
 * than throw — which means a fixture that drifts (a renamed key, an item missing its title)
 * quietly shrinks and the tests built on it keep passing for the wrong reason. These check
 * the RAW shape the normalisers read, and that nothing in a fixture is silently dropped.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { suite, test, assert } from './harness.mjs';
import { normalizeJobs, parseListing, parseNews } from '../lib/serp/normalize';
import { EmployerIntelSchema, PostingSchema } from '../lib/serp/types';

const dir = new URL('../fixtures/serpapi/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const load = (f: string): unknown => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));

const Meta = z.object({
  _synthetic: z.literal(true),
  search_metadata: z.object({ status: z.literal('Success') }).loose(),
  search_parameters: z.object({ engine: z.string(), q: z.string() }).loose(),
});

const JobRaw = z
  .object({
    title: z.string().min(1),
    company_name: z.string().min(1),
    location: z.string(),
    via: z.string().regex(/^via /),
    description: z.string().min(20),
    extensions: z.array(z.string()).optional(),
    detected_extensions: z
      .object({ posted_at: z.string().optional(), schedule_type: z.string().optional(), salary: z.string().optional() })
      .loose()
      .optional(),
    job_highlights: z.array(z.object({ title: z.string(), items: z.array(z.string().min(1)) })).optional(),
    apply_options: z.array(z.object({ title: z.string().min(1), link: z.url() })).optional(),
  })
  .loose();
const JobsFixture = Meta.extend({
  search_parameters: z.object({ engine: z.literal('google_jobs'), q: z.string().min(1) }).loose(),
  jobs_results: z.array(JobRaw).min(1),
});

const ListingFixture = Meta.extend({
  search_parameters: z.object({ engine: z.literal('google_jobs_listing'), q: z.string() }).loose(),
  ratings: z
    .array(z.object({ source: z.string().min(1), link: z.url(), rating: z.number().min(0).max(5), reviews: z.union([z.number(), z.string()]) }))
    .min(1),
});

const NewsFixture = Meta.extend({
  search_parameters: z.object({ engine: z.literal('google_news'), q: z.string() }).loose(),
  news_results: z
    .array(z.object({ title: z.string().min(1), link: z.url(), source: z.object({ name: z.string().min(1) }), date: z.string().min(1) }).loose())
    .min(1),
});

suite('serpapi fixtures: every file is covered by a contract', () => {
  test('there are fixtures, and each is a jobs-*, listing-* or news-* file', () => {
    assert.ok(files.length >= 5, `found ${files.join(', ')}`);
    for (const f of files) assert.match(f, /^(jobs|listing|news)-.+\.json$/, `${f} has no contract here: add one`);
  });
  test('every fixture is flagged synthetic, so real data is never committed by accident', () => {
    for (const f of files) assert.equal((load(f) as { _synthetic?: unknown })._synthetic, true, f);
  });
});

suite('serpapi fixtures: google_jobs', () => {
  for (const f of files.filter((x) => x.startsWith('jobs-'))) {
    test(`${f}: raw shape is what the normaliser reads, and no result is dropped`, () => {
      const raw = JobsFixture.parse(load(f));
      const postings = normalizeJobs(raw, 0);
      assert.equal(postings.length, raw.jobs_results.length, 'normalizeJobs silently dropped an entry');
      for (const p of postings) {
        PostingSchema.parse(p);
        assert.ok(p.key && p.title && p.company, 'identity fields are present');
        assert.ok(!p.via.startsWith('via '), 'the "via " prefix is stripped');
      }
      // (A fixture may repeat a posting on purpose: the dedupe tests depend on it.)
      assert.ok(new Set(postings.map((p) => p.key)).size >= 1);
    });
  }
  test('at least one fixture carries each salary source the radar supports (serp field and free text)', () => {
    const all = files.filter((x) => x.startsWith('jobs-')).flatMap((f) => normalizeJobs(load(f)));
    const sources = new Set(all.map((p) => p.salaryLpa.source));
    assert.ok(sources.has('serp'), 'no posting with SerpApi\'s own salary');
    assert.ok(sources.has('regex'), 'no posting whose salary is read from its text');
  });
});

suite('serpapi fixtures: listing and news', () => {
  for (const f of files.filter((x) => x.startsWith('listing-'))) {
    test(`${f}: ratings parse into an EmployerIntel with a rating`, () => {
      ListingFixture.parse(load(f));
      const intel = EmployerIntelSchema.parse(parseListing(load(f), 'Acme'));
      assert.ok(intel.rating > 0 && intel.rating <= 5);
      assert.ok(intel.ratingSource.length > 0);
      assert.ok(intel.reviewsCount > 0, 'the reviews count ("5.3K" or 1250) was understood');
    });
  }
  for (const f of files.filter((x) => x.startsWith('news-'))) {
    test(`${f}: results parse into headlines, capped at the limit`, () => {
      const raw = NewsFixture.parse(load(f));
      const three = parseNews(raw, 3);
      assert.equal(three.length, Math.min(3, raw.news_results.length));
      for (const h of three) assert.ok(h.title && h.source && h.link.startsWith('https://'));
      assert.equal(parseNews(raw, 100).length, raw.news_results.length, 'no result is dropped under a generous limit');
    });
  }
});
