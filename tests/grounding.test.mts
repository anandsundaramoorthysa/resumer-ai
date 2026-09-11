/**
 * Grounded-rewrite property tests — task 5.8, NFR-8 / REQ-4.4.
 *
 * This is the guard behind the product's central claim: a rewrite may rephrase what a
 * profile record says and nothing else. A hand-written example set can only ever show
 * that the cases someone thought of are handled, so the bulk of this file generates
 * thousands of source/candidate pairs and asserts a property over all of them:
 *
 *     ACCEPTED  =>  every number and every proper noun in the rewrite is in the source
 *
 * The property is checked with a second, independently written token scanner rather than
 * by calling `findUngroundedTokens` again — checking a function against itself would pass
 * no matter what the function did. The scanner honours the two exemptions the guard
 * documents (sentence-initial capitals and grammar words), because those are stated
 * design decisions rather than accidents; everything else it re-derives from scratch.
 *
 * The generator is seeded, so a failure reported here reproduces exactly.
 */

import { assert, report, suite, test } from './harness.mjs';
import {
  acceptRewriteOrFallback,
  extractNumbers,
  extractProperNouns,
  findScopeInflation,
  findUngroundedTokens,
  isGrounded,
} from '@/lib/generate/grounding';

/* --------------------------------------------------- independent scanner ---- */

/**
 * Grammar-capitalized words, restated here on purpose. The guard keeps its own copy
 * private; a test that imported it would inherit any mistake in it rather than catch one.
 */
const GRAMMAR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'built', 'by', 'delivered', 'designed',
  'developed', 'drove', 'for', 'from', 'implemented', 'improved', 'in', 'increased',
  'into', 'led', 'launched', 'managed', 'of', 'on', 'optimized', 'or', 'owned',
  'reduced', 'shipped', 'the', 'to', 'with', 'using', 'across', 'created', 'their',
  'this',
]);

/**
 * Re-derives the claim under test from the candidate text. Returns whatever the
 * candidate asserts that the source does not.
 */
function scanWords(text: string): string[] {
  return text.split(/[\s,;:()[\]"'—–]+/).filter(Boolean);
}

/** Punctuation-insensitive form, so "CI/CD" and "ci/cd" compare equal. */
function flatten(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}+#.]/gu, '');
}

function ungroundedByIndependentScan(candidate: string, source: string): string[] {
  const haystack = source.toLowerCase();
  const sourceWords = new Set(scanWords(source).map(flatten));
  const found: string[] = [];

  scanWords(candidate).forEach((word, index) => {
    const bare = word.replace(/^[^\p{L}\p{N}]+|[.]+$/gu, '');
    if (!bare) return;

    // Quantities: every figure has to occur in the source as a figure of its own.
    // A bare substring test would accept an invented "9x" because the source said
    // "p95", which is exactly the kind of leak this file exists to catch.
    if (/\d/.test(bare)) {
      for (const run of bare.match(/\d[\d,.]*/g) ?? []) {
        const trimmed = run.replace(/[.,]+$/, '');
        if (!trimmed) continue;
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`(?<![\\d.])${escaped}(?!\\d)(?!\\.\\d)`).test(haystack)) {
          found.push(trimmed);
        }
      }
      return;
    }

    const looksProper = /^[\p{Lu}]/u.test(bare) || /[\p{Lu}]{2,}/u.test(bare);
    if (!looksProper) return;

    const normalized = flatten(bare);
    if (!normalized || normalized.length < 2) return;
    if (GRAMMAR_WORDS.has(normalized)) return;
    // The guard deliberately ignores the first word of a sentence, which is capitalized
    // for grammar rather than because it names anything.
    if (index === 0) return;

    if (sourceWords.has(normalized)) return;
    if (haystack.includes(normalized)) return;
    found.push(bare);
  });

  return found;
}

/* ------------------------------------------------------------- generator ---- */

/** Seeded xorshift — a failure here has to be reproducible to be worth reporting. */
function makeRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

const TOOLS = [
  'PostgreSQL', 'React', 'Kubernetes', 'Datadog', 'Snowflake', 'Terraform',
  'GraphQL', 'Redis', 'Kafka', 'Airflow', 'Node.js', 'CI/CD', 'Figma', 'Looker',
];

/** Disjoint from TOOLS, and no member is a substring of any member of TOOLS. */
const FOREIGN_TOOLS = [
  'Salesforce', 'Tableau', 'Jenkins', 'Elasticsearch', 'Vercel', 'Hubspot',
  'Cassandra', 'Grafana',
];

const COMPANIES = ['Acme', 'Contoso', 'Northwind'];
const FOREIGN_COMPANIES = ['Initech', 'Umbrella', 'Wonka'];

const QUANTITIES = ['40%', '200K', '12', '3x', '99.9%', '1.2M', '18', '5x'];
const FOREIGN_QUANTITIES = ['77%', '640K', '31', '9x', '2.6M', '84'];

const OBJECTS = ['checkout flow', 'billing pipeline', 'search index', 'onboarding funnel'];
const OUTCOMES = ['p95 latency', 'organic traffic', 'error rate', 'build time'];
const VERBS = ['Rebuilt', 'Migrated', 'Instrumented', 'Consolidated'];

function pick<T>(rng: () => number, list: T[]): T {
  return list[Math.floor(rng() * list.length) % list.length];
}

interface Pair {
  source: string;
  candidate: string;
  /** True when the candidate was deliberately poisoned with unsourced content. */
  poisoned: boolean;
  seedIndex: number;
}

function buildSource(rng: () => number): string {
  const verb = pick(rng, VERBS);
  const object = pick(rng, OBJECTS);
  const toolA = pick(rng, TOOLS);
  let toolB = pick(rng, TOOLS);
  if (toolB === toolA) toolB = TOOLS[(TOOLS.indexOf(toolA) + 1) % TOOLS.length];
  const company = pick(rng, COMPANIES);
  const qtyA = pick(rng, QUANTITIES);
  const qtyB = pick(rng, QUANTITIES);
  const outcome = pick(rng, OUTCOMES);

  return `${verb} the ${object} at ${company} on ${toolA} and ${toolB}, serving ${qtyA} requests and cutting ${outcome} ${qtyB}.`;
}

/**
 * Faithful rewrites: reordering, dropping detail, and swapping ordinary words. Every
 * one of these must survive the guard, or the guard is not a filter, it is a wall.
 */
function faithfulRewrite(rng: () => number, source: string): string {
  const tools = source.match(/on ([^,]+) and ([^,]+),/);
  const toolA = tools?.[1] ?? '';
  const toolB = tools?.[2] ?? '';
  const roll = rng();

  if (roll < 0.25 && toolA && toolB) {
    return source.replace(`on ${toolA} and ${toolB},`, `on ${toolB} and ${toolA},`);
  }
  if (roll < 0.5) {
    return source.replace(/ and cutting [^.]+\./, '.');
  }
  if (roll < 0.75) {
    return source
      .replace(' the ', ' a ')
      .replace(' serving ', ' handling ')
      .replace(' cutting ', ' lowering ');
  }
  return source.replace(/\.$/, ' end to end.');
}

function poisonedRewrite(rng: () => number, source: string): string {
  const roll = rng();
  if (roll < 0.34) {
    return source.replace(/\.$/, ` using ${pick(rng, FOREIGN_TOOLS)}.`);
  }
  if (roll < 0.67) {
    return source.replace(/\.$/, ` for ${pick(rng, FOREIGN_QUANTITIES)} customers.`);
  }
  return source.replace(/ at (\w+) on /, ` at ${pick(rng, FOREIGN_COMPANIES)} on `);
}

function generatePairs(count: number, seed = 20260906): Pair[] {
  const rng = makeRandom(seed);
  const pairs: Pair[] = [];

  for (let i = 0; i < count; i++) {
    const source = buildSource(rng);
    const poisoned = rng() < 0.5;
    const candidate = poisoned
      ? poisonedRewrite(rng, source)
      : faithfulRewrite(rng, source);
    pairs.push({ source, candidate, poisoned, seedIndex: i });
  }

  return pairs;
}

const PAIR_COUNT = 3_000;
const pairs = generatePairs(PAIR_COUNT);

/* ------------------------------------------------------------ properties ---- */

suite(`grounding properties over ${PAIR_COUNT} generated pairs (NFR-8)`, () => {
  test('an accepted rewrite never contains a number the source lacks', () => {
    const offenders: string[] = [];
    for (const pair of pairs) {
      const result = acceptRewriteOrFallback(pair.candidate, pair.source);
      if (!result.accepted) continue;
      const sourceNumbers = new Set(extractNumbers(pair.source));
      const lower = pair.source.toLowerCase();
      for (const n of extractNumbers(result.text)) {
        const known =
          sourceNumbers.has(n) || lower.includes(n.replace(/[%kmbx+]/g, ''));
        if (!known) offenders.push(`#${pair.seedIndex} "${n}" :: ${result.text}`);
      }
    }
    assert.deepEqual(offenders.slice(0, 5), [], `${offenders.length} accepted rewrites carried an unsourced number`);
  });

  test('an accepted rewrite never contains a proper noun the source lacks', () => {
    const offenders: string[] = [];
    for (const pair of pairs) {
      const result = acceptRewriteOrFallback(pair.candidate, pair.source);
      if (!result.accepted) continue;
      const sourceEntities = new Set(extractProperNouns(pair.source));
      const lower = pair.source.toLowerCase();
      for (const e of extractProperNouns(result.text)) {
        if (!sourceEntities.has(e) && !lower.includes(e)) {
          offenders.push(`#${pair.seedIndex} "${e}" :: ${result.text}`);
        }
      }
    }
    assert.deepEqual(offenders.slice(0, 5), [], `${offenders.length} accepted rewrites carried an unsourced entity`);
  });

  test('an independent token scan agrees on every accepted rewrite', () => {
    const offenders: string[] = [];
    for (const pair of pairs) {
      const result = acceptRewriteOrFallback(pair.candidate, pair.source);
      if (!result.accepted) continue;
      const leaked = ungroundedByIndependentScan(result.text, pair.source);
      if (leaked.length > 0) {
        offenders.push(`#${pair.seedIndex} ${JSON.stringify(leaked)} :: ${result.text}`);
      }
    }
    assert.deepEqual(offenders.slice(0, 5), [], `${offenders.length} accepted rewrites failed the independent scan`);
  });

  test('every deliberately poisoned rewrite is rejected', () => {
    const escaped: string[] = [];
    let checked = 0;
    for (const pair of pairs) {
      if (!pair.poisoned) continue;
      // Only count it as poisoned if the injected token really is absent from the
      // source — a coincidental substring would make this an unfair expectation.
      if (ungroundedByIndependentScan(pair.candidate, pair.source).length === 0) continue;
      checked += 1;
      if (isGrounded(pair.candidate, pair.source)) {
        escaped.push(`#${pair.seedIndex} :: ${pair.candidate}`);
      }
    }
    assert.ok(checked > 500, `expected a large poisoned sample, got ${checked}`);
    assert.deepEqual(escaped.slice(0, 5), [], `${escaped.length} of ${checked} fabrications slipped through`);
  });

  test('a rejected rewrite falls back to the source text verbatim', () => {
    let rejected = 0;
    for (const pair of pairs) {
      const result = acceptRewriteOrFallback(pair.candidate, pair.source);
      if (result.accepted) continue;
      rejected += 1;
      assert.equal(result.text, pair.source, `#${pair.seedIndex} lost the original wording`);
      assert.ok(result.violations.length > 0, `#${pair.seedIndex} rejected with no reason given`);
    }
    assert.ok(rejected > 500, `expected a large rejected sample, got ${rejected}`);
  });

  test('faithful rewrites are accepted — the guard filters, it does not block', () => {
    const faithful = pairs.filter((p) => !p.poisoned);
    const accepted = faithful.filter(
      (p) => acceptRewriteOrFallback(p.candidate, p.source).accepted,
    );
    const rate = accepted.length / faithful.length;
    assert.ok(
      rate > 0.95,
      `only ${(rate * 100).toFixed(1)}% of faithful rewrites survived; the guard is rejecting honest work`,
    );
  });

  test('a source is always grounded in itself', () => {
    for (const pair of pairs) {
      assert.ok(isGrounded(pair.source, pair.source), `#${pair.seedIndex} rejected its own text`);
    }
  });
});

/* --------------------------------------------------------- worked cases ---- */

suite('grounding, specific cases', () => {
  const source =
    'Optimized PostgreSQL queries serving 200K daily requests, cutting p95 latency 40%.';

  test('accepts a pure reordering', () => {
    const r = acceptRewriteOrFallback(
      'Cut p95 latency 40% by optimizing PostgreSQL queries serving 200K daily requests.',
      source,
    );
    assert.equal(r.accepted, true, JSON.stringify(r.violations));
  });

  test('rejects an inflated metric', () => {
    const r = acceptRewriteOrFallback(
      'Optimized PostgreSQL queries serving 200K daily requests, cutting p95 latency 60%.',
      source,
    );
    assert.equal(r.accepted, false);
    assert.equal(r.text, source);
    assert.ok(r.violations.some((v) => v.kind === 'number' && v.token.startsWith('60')));
  });

  test('rejects a tool that was never in the source', () => {
    const r = acceptRewriteOrFallback(
      'Optimized PostgreSQL and Redis queries serving 200K daily requests, cutting p95 latency 40%.',
      source,
    );
    assert.equal(r.accepted, false);
    assert.ok(r.violations.some((v) => v.kind === 'entity' && v.token === 'redis'));
  });

  test('rejects an invented employer', () => {
    const r = acceptRewriteOrFallback(
      'At Initech, optimized PostgreSQL queries serving 200K daily requests, cutting p95 latency 40%.',
      source,
    );
    assert.equal(r.accepted, false);
    assert.ok(r.violations.some((v) => v.token === 'initech'));
  });

  test('rejects an empty rewrite rather than shipping a blank bullet', () => {
    const r = acceptRewriteOrFallback('   ', source);
    assert.equal(r.accepted, false);
    assert.equal(r.text, source);
  });

  test('accepts dropping detail — a shorter rewrite claims less, never more', () => {
    const r = acceptRewriteOrFallback('Optimized PostgreSQL queries.', source);
    assert.equal(r.accepted, true, JSON.stringify(r.violations));
  });

  test('tech-shaped tokens are checked even in lower case', () => {
    const withNode = 'Built the ingest worker in Node.js against Kafka.';
    assert.equal(isGrounded('Built the ingest worker in node.js against Kafka.', withNode), true);
    assert.equal(isGrounded('Built the ingest worker in next.js against Kafka.', withNode), false);
  });

  test('an acronym introduced mid-sentence is caught', () => {
    const base = 'Led the migration of the billing service.';
    assert.equal(isGrounded('Led the SOC2 migration of the billing service.', base), false);
  });

  test('number formatting variants of the same figure are treated as the same figure', () => {
    const base = 'Cut spend by 1.2M dollars.';
    assert.equal(isGrounded('Cut spend by 1.2 million dollars.', base), true);
  });

  test('a figure is not grounded by a digit buried inside a different figure', () => {
    // Regression: an unanchored substring test accepted an invented "9x" because the
    // source said "p95". Found by the generated pairs above, 7 escapes in 1,439.
    const base = 'Optimized queries, cutting p95 latency 40%.';
    assert.equal(isGrounded('Optimized queries for 9x more users.', base), false);
    assert.equal(isGrounded('Optimized queries, cutting p95 latency 40%.', base), true);
  });

  test('the same figure is still recognised across unit spellings', () => {
    assert.equal(isGrounded('Grew traffic 40%.', 'Grew traffic 40 percent.'), true);
    assert.equal(isGrounded('Served 200K users.', 'Served 200,000 users.'), true);
  });

  test('findUngroundedTokens names both the kind and the token', () => {
    const v = findUngroundedTokens('Shipped Vercel deploys in 8 hours.', 'Shipped deploys.');
    assert.ok(v.some((x) => x.kind === 'entity' && x.token === 'vercel'));
    assert.ok(v.some((x) => x.kind === 'number' && x.token === '8'));
  });

  test("a rewrite may not add a posting term its source doesn't state — the EA rewrites", () => {
    const terms = ['predictive modeling', 'business questions', 'Python'];
    const src = 'Integrated open-source AI models into web applications using Flask.';
    const r = acceptRewriteOrFallback(
      'Integrated predictive modeling AI models into web applications using Flask.',
      src,
      terms,
    );
    assert.equal(r.accepted, false);
    assert.deepEqual(r.violations, [{ kind: 'keyword', token: 'predictive modeling' }]);
    assert.equal(
      acceptRewriteOrFallback(
        'Collaborated with clients to define business questions and requirements.',
        'Collaborated with clients to understand their market, audience, and technical requirements.',
        terms,
      ).accepted,
      false,
    );
  });

  test('a posting term the source already states may be kept or reworded', () => {
    const terms = ['predictive modeling', 'integration'];
    assert.equal(
      acceptRewriteOrFallback(
        'Delivered predictive modeling for churn in the billing app.',
        'Did predictive modeling for churn in the billing app.',
        terms,
      ).accepted,
      true,
    );
    // Matched as the gate matches, so a plural in the source still states the term.
    assert.equal(
      acceptRewriteOrFallback('Owned the payment integration.', 'Owned the payment integrations.', terms).accepted,
      true,
    );
  });
});

report('grounding');

suite('a rewrite may not claim more of the work than the source did', () => {
  const refused = (source: string, candidate: string) => findScopeInflation(candidate, source).length > 0;

  test('dropping the hedge is a fabrication the nouns cannot show', () => {
    assert(refused('Helped clients build a churn dashboard', 'Built a churn dashboard for clients'), 'helped');
    assert(refused('Contributed to an open-source parser', 'Maintained an open-source parser'), 'contributed to');
    assert(refused('Assisted with the migration to Postgres', 'Delivered the migration to Postgres'), 'assisted');
  });

  test('adding a word of ownership the source never used is refused', () => {
    assert(refused('Built a churn dashboard for the sales team', 'Led the churn dashboard for the sales team'), 'led');
    assert(refused('Wrote the ingestion scripts', 'Owned the ingestion pipeline'), 'owned');
  });

  test('keeping the hedge, or the ownership the source already stated, is fine', () => {
    assert(!refused('Helped clients build a churn dashboard', 'Helped clients build a churn dashboard in Streamlit'), 'hedge kept');
    assert(!refused('Led the migration to Postgres', 'Led the migration to PostgreSQL'), 'already led it');
    assert(!refused('Built a churn dashboard', 'Built a churn dashboard that cut reporting time'), 'ordinary tightening');
  });

  test('the whole guard refuses it, not just this rule', () => {
    const r = acceptRewriteOrFallback('Led the rollout of the billing service', 'Built the billing service');
    assert(!r.accepted && r.text === 'Built the billing service', 'the user own words are printed');
  });
});

suite('the hedge rule needs the source to be the same claim', () => {
  test('a summary checked against the whole profile is not deleted by one "helped" elsewhere', () => {
    const profile = `Skills: Python, SQL, Streamlit. ${'Helped the team with reporting. '.repeat(20)}Built a churn dashboard.`;
    const sentence = 'Data analyst who builds dashboards in Python and SQL.';
    assert(findScopeInflation(sentence, profile).length === 0, 'kept');
  });

  test('but claiming to have led something the profile never mentions still fails', () => {
    const profile = `Skills: Python, SQL. ${'Wrote reports for the team. '.repeat(20)}`;
    assert(findScopeInflation('Led the analytics team', profile).length > 0, 'refused');
  });
});
