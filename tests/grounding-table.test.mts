/**
 * Grounding, table-driven — the escapes found by the audit, and the rewrites that must keep
 * working. Companion to tests/grounding.test.mts (which generates thousands of pairs).
 *
 * Each row is `[name, source, candidate]`. A MUST-REJECT row is a fabrication the old
 * substring/unit-stripping guard let through ("Java" against "JavaScript", "₹10 crore"
 * against "₹10 lakh", "tripling" with no figure anywhere); a MUST-ACCEPT row is an honest
 * rewrite that a stricter guard must not start refusing (paraphrase, reorder, plural, unit
 * spelling, "Next.js" for "NextJS").
 */

import { assert, report, suite, test } from './harness.mjs';
import { extractNumbers, extractProperNouns, findUngroundedTokens, isGrounded } from '@/lib/generate/grounding';

const ZWSP = String.fromCharCode(0x200b);

type Row = [name: string, source: string, candidate: string];

const MUST_REJECT: Row[] = [
  ['Java is not JavaScript', 'Built an API in JavaScript.', 'Built an API in Java.'],
  ['SQL is not PostgreSQL', 'Queried PostgreSQL daily.', 'Queried SQL daily.'],
  ['Git is not GitHub', 'Hosted the code on GitHub.', 'Hosted the code on Git.'],
  ['Spring is not Springer', 'Reviewed papers for Springer.', 'Reviewed papers for Spring.'],
  ['crore is not lakh', 'Saved ₹10 lakh in costs.', 'Saved ₹10 crore in costs.'],
  ['lakh is not crore (the other way)', 'Saved ₹10 crore in costs.', 'Saved ₹10 lakh in costs.'],
  ['3x is not 3%', 'Grew revenue 3%.', 'Grew revenue 3x.'],
  ['40M is not 40%', 'Grew revenue 40%.', 'Grew revenue 40M.'],
  ['40% is not 40M', 'Grew revenue 40M.', 'Grew revenue 40%.'],
  ['10 million is not 10k', 'Served 10k users.', 'Served 10 million users.'],
  ['a bare 200 is not 200K', 'Served 200K users.', 'Served 200 users.'],
  ['dollars are not rupees', 'Saved ₹5M annually.', 'Saved $5M annually.'],
  ['10,000 is not 1,000', 'Cut cost by 10,000.', 'Cut cost by 1,000.'],
  ['a number word is a new claim: tripling', 'Grew signups.', 'Grew signups, tripling adoption.'],
  ['a number word is a new claim: ten teams', 'Built dashboards for teams.', 'Built dashboards for ten teams.'],
  ['a dozen', 'Fixed bugs.', 'Fixed a dozen bugs.'],
  ['in half', 'Cut costs.', 'Cut costs in half.'],
  ['doubled', 'Grew revenue.', 'Doubled revenue.'],
  ['quadrupling', 'Improved throughput.', 'Improved throughput, quadrupling it.'],
  ['lowercase employer', 'Built a dashboard.', 'Built a dashboard at google.'],
  ['lowercase tool', 'Deployed with Docker.', 'Deployed with docker and kubernetes.'],
  ['full-width digits are still digits', 'Cut load time.', 'Cut load time ４０%.'],
  ['Cyrillic K in Kubernetes', 'Deployed with Docker.', 'Deployed with Docker on Кubernetes.'],
  ['zero-width space inside a figure', 'Cut cost.', `Cut cost by 4${ZWSP}0%.`],
  ['a name in Devanagari the source never had', 'Built a dashboard.', 'Built a dashboard at गूगल.'],
  ['a name in Tamil the source never had', 'Built a dashboard.', 'Built a dashboard for இன்ஃபோசிஸ்.'],
  ['C++ is not C', 'Wrote drivers in C.', 'Wrote drivers in C++.'],
  ['Next.js is not Node.js', 'Built the ingest worker in Node.js.', 'Built the ingest worker in Next.js.'],
  ['a percent figure the source lacks', 'Cut cost.', 'Cut cost 60 percent.'],
  ['a spelled-out figure that is a different number', 'Trained 10 interns.', 'Trained twenty interns.'],
];

const MUST_ACCEPT: Row[] = [
  ['identical text', 'Built dashboards in Python and SQL.', 'Built dashboards in Python and SQL.'],
  [
    'reordered words',
    'Built dashboards in Python and SQL for sales teams.',
    'For sales teams, built dashboards in SQL and Python.',
  ],
  ['plural to singular', 'Maintained APIs for clients.', 'Maintained an API for clients.'],
  ['singular to plural', 'Maintained an API for clients.', 'Maintained APIs for clients.'],
  ['NextJS written as Next.js', 'Built the site with NextJS.', 'Built the site with Next.js.'],
  ['Next.js written as NextJS', 'Built the site with Next.js.', 'Built the site with NextJS.'],
  ['percent for %', 'Grew traffic 40%.', 'Grew traffic 40 percent.'],
  ['% for percent', 'Grew traffic 40 percent.', 'Grew traffic 40%.'],
  ['a spaced percent sign', 'Grew traffic 40%.', 'Grew traffic 40 %.'],
  ['Indian grouping as lakh', 'Served 1,00,000 users.', 'Served 1 lakh users.'],
  ['Indian grouping as k', 'Served 1,00,000 users.', 'Served 100k users.'],
  ['Indian grouping as plain digits', 'Served 1,00,000 users.', 'Served 100000 users.'],
  ['Indian grouping as Western grouping', 'Served 1,00,000 users.', 'Served 100,000 users.'],
  ['thousands separator dropped', 'Latency fell below 1,000 ms.', 'Latency fell below 1000 ms.'],
  ['rupee sign for Rs.', 'Saved Rs. 10 lakh.', 'Saved ₹10 lakh.'],
  ['rupee sign for INR', 'Saved INR 10 lakh.', 'Saved ₹10 lakh.'],
  ['dropping the currency sign', 'Saved ₹10 lakh.', 'Saved 10 lakh.'],
  ['crore as cr', 'Saved ₹10 crore.', 'Saved ₹10 cr.'],
  ['number word for digit', 'Trained 10 interns.', 'Trained ten interns.'],
  ['digit for number word', 'Trained ten interns.', 'Trained 10 interns.'],
  ['tripled for 3x', 'Grew signups 3x.', 'Tripled signups.'],
  ['doubled for 2x', 'Grew signups 2x.', 'Doubled signups.'],
  ['half for 50%', 'Cut costs 50%.', 'Cut costs by half.'],
  ['3 times for 3x', 'Grew signups 3x.', 'Grew signups 3 times.'],
  ['thousand for K', 'Served 200K users.', 'Served 200 thousand users.'],
  ['million for M', 'Cut spend by $1.2M.', 'Cut spend by $1.2 million.'],
  ['JS for JavaScript', 'Wrote JavaScript services.', 'Wrote JS services.'],
  ['Postgres for PostgreSQL', 'Tuned PostgreSQL queries.', 'Tuned Postgres queries.'],
  ['Node for Node.js', 'Built services in Node.js.', 'Built services in Node.'],
  ['dropping detail', 'Optimized PostgreSQL queries, cutting latency 40%.', 'Optimized PostgreSQL queries.'],
  ['a lowercase tool kept lowercase', 'Deployed with docker and kubernetes.', 'Deployed with kubernetes and docker.'],
  ['full-width digits on both sides', 'Cut load time ４０%.', 'Cut load time 40%.'],
  ['"5 more" is five, not five million', 'Hired 5 more people.', 'Hired 5 people.'],
  ['a one-word idiom is not a quantity', 'Built a one-click deploy.', 'Built a one-click deploy for the team.'],
  ['lowercase github actions', 'Automated builds with GitHub Actions.', 'Automated builds with github actions.'],
  ['CI/CD', 'Owned CI/CD pipelines.', 'Owned the CI/CD pipeline.'],
  ['a name in Devanagari that is in the source', 'Built apps at इन्फोसिस.', 'Built apps at इन्फोसिस.'],
  ['case only', 'Used python daily.', 'Used Python daily.'],
];

suite('grounding table — must reject', () => {
  for (const [name, source, candidate] of MUST_REJECT) {
    test(name, () => {
      const v = findUngroundedTokens(candidate, source);
      assert.ok(v.length > 0, `accepted a fabrication: "${candidate}" against "${source}"`);
    });
  }
  test('the table is the size the audit asked for', () => assert.ok(MUST_REJECT.length >= 20, String(MUST_REJECT.length)));
});

suite('grounding table — must accept', () => {
  for (const [name, source, candidate] of MUST_ACCEPT) {
    test(name, () => {
      const v = findUngroundedTokens(candidate, source);
      assert.deepEqual(v, [], `refused an honest rewrite: "${candidate}" against "${source}"`);
    });
  }
  test('the table is the size the audit asked for', () => assert.ok(MUST_ACCEPT.length >= 20, String(MUST_ACCEPT.length)));
});

suite('grounding — number extraction', () => {
  test('"5 more people" extracts 5, not 5m', () => {
    assert.deepEqual(extractNumbers('5 more people, 3 books'), ['5', '3']);
  });
  test('a thousands separator does not change the figure', () => {
    assert.ok(isGrounded('Under 1000 ms.', 'Under 1,000 ms.'));
    assert.ok(isGrounded('Under 1,000 ms.', 'Under 1000 ms.'));
  });
  test('1,000 and 1.000 are different figures', () => {
    assert.ok(!isGrounded('Cut cost by 1,000', 'Cut cost by 1.000'));
  });
  test('long digit runs do not blow up', () => {
    const t = Date.now();
    extractNumbers('1'.repeat(100_000) + '!');
    findUngroundedTokens('A '.repeat(50_000), 'B '.repeat(50_000));
    assert.ok(Date.now() - t < 3000, `took ${Date.now() - t}ms`);
  });
  test('proper nouns are whole tokens', () => {
    assert.deepEqual(extractProperNouns('Built it with Node.js and C++ and C#'), ['node.js', 'c++', 'c#']);
  });
});

report('grounding-table');
