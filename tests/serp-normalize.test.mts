/** SerpApi JSON -> Posting / EmployerIntel, against the bundled India fixtures. */

import { readFileSync } from 'node:fs';
import { assert, suite, test } from './harness.mjs';
import { dedupePostings, normalizeJobs, parseGoogleRating, parseListing, parseNews, postingKey } from '@/lib/serp/normalize';
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
    assert.equal(z.key, postingKey('Full Stack Developer', 'Sample Systems Pvt Ltd'));
    assert.deepEqual(z.salaryLpa, { min: 12, max: 18, source: 'serp' }); // from extensions[] "12–18 LPA"
  });
  test('tolerates missing detected_extensions and job_highlights', () => {
    const swiggy = jobs.find((j) => j.company === 'Demo Foods')!;
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

suite('live payload shape (extensions[] instead of detected_extensions)', () => {
  const live = {
    jobs_results: [
      { title: 'Role A', company_name: 'Co A', location: 'Chennai', via: 'via LinkedIn', description: 'Build things.', job_id: 'x', apply_options: [], extensions: ['12 hours ago', '₹75K–₹85K a month', 'Full–time'] },
      { title: 'Role B', company_name: 'Co B', description: 'Build more.', extensions: ['8 hours ago', 'Contractor'] },
    ],
  };
  const [a, b] = normalizeJobs(live);
  test('postedAt, scheduleType and salary come from extensions[]', () => {
    assert.equal(a.postedAt, '12 hours ago');
    assert.equal(a.scheduleType, 'Full–time');
    assert.equal(a.salaryLpa.source, 'serp');
    assert.equal(a.salaryLpa.min, 9);
    assert.equal(a.salaryLpa.max, 10.2);
    assert.equal(b.postedAt, '8 hours ago');
    assert.equal(b.scheduleType, 'Contractor');
    assert.equal(b.salaryLpa.source, 'none');
  });
});

suite('dedupePostings', () => {
  const deduped = dedupePostings(normalizeJobs(fx('jobs-fullstack-bengaluru')));

  test('collapses the same title+company', () => {
    assert.equal(deduped.length, 4);
  });
  test('keeps the richest description and merges apply links', () => {
    const z = deduped.find((j) => j.company === 'Sample Systems Pvt Ltd')!;
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
    const i = parseListing(fx('listing-sample'), 'Sample Systems');
    assert.deepEqual(i, { company: 'Sample Systems', rating: 4.2, ratingSource: 'Sample Reviews', reviewsCount: 5300, headlines: [] });
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
    assert.equal(n[0].source, 'Sample Business Daily');
    assert.deepEqual(parseNews({}), []);
  });
});

suite('untrusted input', () => {
  const job = (extra: Record<string, unknown>) => ({
    jobs_results: [{ title: 'Dev', company_name: 'Acme', ...extra }],
  });
  test('only absolute http(s) apply links survive', () => {
    const [p] = normalizeJobs(
      job({
        apply_options: [
          { title: 'a', link: 'javascript:alert(1)' },
          { title: 'b', link: 'data:text/html,<script>alert(1)</script>' },
          { title: 'c', link: '/relative/path' },
          { title: 'd', link: '' },
          { title: 'e', link: 'https://example.com/ok' },
          { title: 'f', link: 'http://example.com/ok2' },
        ],
      }),
    );
    assert.deepEqual(p.applyLinks.map((l) => l.link), ['https://example.com/ok', 'http://example.com/ok2']);
  });
  test('news links are http(s) only; the item is dropped otherwise', () => {
    const n = parseNews({
      news_results: [
        { title: 'bad', link: 'javascript:alert(1)', source: 'x' },
        { title: 'good', link: 'https://example.com/n', source: 'x' },
      ],
    });
    assert.deepEqual(n.map((x) => x.title), ['good']);
  });
  test('lengths are capped', () => {
    const long = 'x'.repeat(1000);
    const [p] = normalizeJobs({
      jobs_results: [
        {
          title: long,
          company_name: long,
          via: `via ${long}`,
          apply_options: Array.from({ length: 10 }, (_, i) => ({ title: long, link: `https://example.com/${i}` })).concat([
            { title: 'long', link: `https://example.com/${long}` },
          ]),
          job_highlights: [{ items: Array.from({ length: 30 }, () => long) }],
        },
      ],
    });
    assert.equal(p.title.length, 200);
    assert.equal(p.company.length, 120);
    assert.equal(p.via.length, 60);
    assert.equal(p.applyLinks.length, 6);
    assert.ok(p.applyLinks.every((l) => l.title.length <= 120 && l.link.length <= 500));
    assert.equal(p.highlights.length, 12);
    assert.ok(p.highlights.every((h) => h.length === 300));
    const news = parseNews({ news_results: Array.from({ length: 9 }, (_, i) => ({ title: 't', link: `https://e.com/${i}` })) }, 99);
    assert.equal(news.length, 5);
  });
});

suite('parseGoogleRating / parseNews relevance (live shapes, 2026-10-06)', () => {
  // scrubbed fragment of a real engine=google "Walmart Global Tech India reviews" response
  const g = {
    organic_results: [
      { source: 'LinkedIn', title: 'Walmart Global Tech India', link: 'https://in.linkedin.com/x' },
      { source: 'AmbitionBox', title: 'Walmart Reviews by 3300+ Employees', link: 'https://www.ambitionbox.com/x', rich_snippet: { top: { detected_extensions: { rating: 3.5, reviews: 3384 } } } },
      { source: 'glassdoor.co.in', title: 'Walmart Global Tech Reviews - Glassdoor', link: 'https://www.glassdoor.co.in/x', rich_snippet: { top: { detected_extensions: { rating: 3.6, reviews: 3961 } } } },
    ],
  };
  test('prefers Glassdoor, labels the source as via Google', () => {
    const r = parseGoogleRating(g, 'Walmart Global Tech India');
    assert.deepEqual(r, { rating: 3.6, ratingSource: 'Glassdoor (via Google)', reviewsCount: 3961 });
  });
  test('no rating when the title does not name the company, or nothing parses', () => {
    assert.equal(parseGoogleRating(g, 'Zoho').rating, 0);
    assert.equal(parseGoogleRating({}, 'Zoho').rating, 0);
    assert.equal(parseGoogleRating(null, 'Zoho').ratingSource, '');
  });
  test('headlines not mentioning the company are dropped', () => {
    const n = { news_results: [
      { title: 'Acme Robotics raises funds', link: 'https://e.com/1', source: 'X', date: 'd' },
      { title: 'Quick quest for open source', link: 'https://e.com/2', source: 'X', date: 'd' },
    ] };
    assert.deepEqual(parseNews(n, 3, 'Acme Robotics Pvt Ltd').map((h) => h.link), ['https://e.com/1']);
    assert.equal(parseNews(n).length, 2);
  });
  test('google_jobs_listing "Fully empty" answer is rating 0', () => {
    assert.equal(parseListing({ search_information: { jobs_listing_state: 'Fully empty' }, error: "Google hasn't returned any results" }, 'Acme').rating, 0);
  });
});
