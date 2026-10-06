/** SerpApi JSON -> Posting / EmployerIntel, against the bundled India fixtures. */

import { readFileSync } from 'node:fs';
import { assert, suite, test } from './harness.mjs';
import { dedupePostings, normalizeJobs, parseListing, parseNews, postingKey } from '@/lib/serp/normalize';
import { PostingSchema } from '@/lib/serp/types';

const fx = (n: string) => JSON.parse(readFileSync(`fixtures/serpapi/${n}.json`, 'utf8'));

suite('normalizeJobs', () => {
  const jobs = normalizeJobs(fx('jobs-fullstack-bengaluru'), 1);

  test('every posting passes the schema and carries the query index', () => {
    assert.equal(jobs.length, 5);
    for (const j of jobs) {
      PostingSchema.parse(j);
      assert.equal(j.fromQuery, 1);
    }
  });
  test('maps fields and strips "via "', () => {
    const z = jobs[0];
    assert.equal(z.via, 'Naukri');
    assert.equal(z.postedAt, '3 days ago');
    assert.equal(z.applyLinks.length, 2);
    assert.equal(z.key, postingKey('Full Stack Developer', 'Zoho Corporation'));
    assert.deepEqual(z.salaryLpa, { min: 12, max: 18, source: 'regex' });
  });
  test('tolerates missing detected_extensions and job_highlights', () => {
    const swiggy = jobs.find((j) => j.company === 'Swiggy')!;
    assert.equal(swiggy.postedAt, '');
    assert.equal(swiggy.scheduleType, '');
    assert.deepEqual(swiggy.highlights, []);
    assert.deepEqual(swiggy.salaryLpa, { min: 18, max: 26, source: 'regex' });
  });
  test('serp salary field is used and labelled', () => {
    const [first] = normalizeJobs(fx('jobs-data-analyst-chennai'));
    assert.deepEqual(first.salaryLpa, { min: 6, max: 10, source: 'serp' });
  });
  test('garbage input yields nothing', () => {
    assert.deepEqual(normalizeJobs(null), []);
    assert.deepEqual(normalizeJobs({ jobs_results: [{ company_name: 'x' }, 5] }), []);
  });
});

suite('dedupePostings', () => {
  const deduped = dedupePostings(normalizeJobs(fx('jobs-fullstack-bengaluru')));

  test('collapses the same title+company', () => {
    assert.equal(deduped.length, 4);
  });
  test('keeps the richest description and merges apply links', () => {
    const z = deduped.find((j) => j.company === 'Zoho Corporation')!;
    assert.ok(z.description.length > 100);
    assert.equal(z.applyLinks.length, 3);
    assert.equal(new Set(z.applyLinks.map((l) => l.link)).size, 3);
  });
  test('is case-insensitive on the key', () => {
    assert.equal(postingKey('React Dev', 'ACME'), postingKey('react dev', 'acme'));
  });
});

suite('parseListing / parseNews', () => {
  test('best rating, reviews like "5.3K" parsed', () => {
    const i = parseListing(fx('listing-sample'), 'Zoho');
    assert.deepEqual(i, { company: 'Zoho', rating: 4.2, ratingSource: 'AmbitionBox', reviewsCount: 5300, headlines: [] });
  });
  test('rating 0 when the listing has none', () => {
    const i = parseListing({}, 'Acme');
    assert.equal(i.rating, 0);
    assert.equal(i.reviewsCount, 0);
    assert.equal(parseListing(null, 'Acme').rating, 0);
  });
  test('news capped at 3, source name flattened', () => {
    const n = parseNews(fx('news-sample'));
    assert.equal(n.length, 3);
    assert.equal(n[0].source, 'The Hindu BusinessLine');
    assert.deepEqual(parseNews({}), []);
  });
});
