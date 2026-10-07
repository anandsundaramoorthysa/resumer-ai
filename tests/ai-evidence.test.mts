/**
 * The evidence judge — lib/quality/evidence.ts: two votes, lower grade wins, strict ids.
 *
 * The model is a stub behind `setChainDeps`; nothing here touches a provider.
 */

delete process.env.DATABASE_URL;

import { combineVotes, scoreEvidence, scoreFromGrades, validateGrades, type EvidenceLine } from '../lib/quality/evidence';
import { setChainDeps, setCooldownBackend, resetCooldownCache, resetBreakers, setTelemetrySink } from '../lib/ai/chain';
import { suite, suiteAsync, test, testAsync, assert } from './harness.mjs';

type Grade = 'strong' | 'partial' | 'weak';
const ORDER: Grade[] = ['weak', 'partial', 'strong'];

function lines(n: number): EvidenceLine[] {
  return Array.from({ length: n }, (_, i) => ({ id: `L${i + 1}`, sectionKey: 'experience' as const, itemIndex: i, text: `line ${i + 1}` }));
}

/** Deterministic RNG so the measured numbers are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A judge that is right `p` of the time and otherwise one grade off. */
function noisyVote(truth: Grade[], p: number, rand: () => number) {
  return truth.map((g, i) => {
    if (rand() < p) return { id: `L${i + 1}`, grade: g };
    const k = ORDER.indexOf(g);
    const wrong = k === 0 ? 1 : k === 2 ? 1 : rand() < 0.5 ? 0 : 2;
    return { id: `L${i + 1}`, grade: ORDER[wrong] };
  });
}

const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

suite('validateGrades / combineVotes', () => {
  const ls = lines(3);

  test('ids that are not on the page are dropped, duplicates keep the lower grade', () => {
    const v = validateGrades(ls, [
      { id: 'L1', grade: 'strong' },
      { id: 'L1', grade: 'weak' },
      { id: 'L99', grade: 'strong' },
      { id: 'L2: strong', grade: 'strong' },
      { id: ' l3 ', grade: 'partial' },
    ]);
    assert.deepEqual(v.map((g) => [g.id, g.grade]), [['L1', 'weak'], ['L3', 'partial']]);
  });

  test('the lower vote wins per line, and a missing line is weak', () => {
    const c = combineVotes(ls, [
      [{ id: 'L1', grade: 'strong' }, { id: 'L2', grade: 'strong' }, { id: 'L3', grade: 'partial' }],
      [{ id: 'L1', grade: 'partial' }, { id: 'L2', grade: 'strong' }],
    ]);
    assert.deepEqual(c.map((g) => g.grade), ['partial', 'strong', 'weak']);
  });
});

suite('judge noise: two votes, lower wins', () => {
  test('the variance of the evidence score falls (measured on a stub judge, p(correct)=0.7)', () => {
    const truth: Grade[] = [...Array(8).fill('strong'), ...Array(8).fill('partial'), ...Array(4).fill('weak')];
    const ls = lines(truth.length);
    const rand = rng(42);
    const single: number[] = [];
    const two: number[] = [];
    const twoConfirmed: number[] = [];
    const trueScore = scoreFromGrades(ls, truth.map((g, i) => ({ id: `L${i + 1}`, grade: g }))).score;
    const run = () => scoreFromGrades(ls, combineVotes(ls, [noisyVote(truth, 0.7, rand), noisyVote(truth, 0.7, rand)])).score;
    for (let i = 0; i < 2000; i++) {
      single.push(scoreFromGrades(ls, noisyVote(truth, 0.7, rand)).score);
      const a = run();
      two.push(a);
      twoConfirmed.push(Math.min(a, run()));
    }
    const k = 3; // evidence weight 0.30 x 10 points: overall-score units
    console.log(
      `       evidence sd (overall units): 1 vote ${(sd(single) * k).toFixed(3)}, ` +
        `2 votes lower-wins ${(sd(two) * k).toFixed(3)}, ` +
        `+ winner re-grade ${(sd(twoConfirmed) * k).toFixed(3)}; ` +
        `bias vs truth: ${((mean(single) - trueScore) * k).toFixed(3)} / ` +
        `${((mean(two) - trueScore) * k).toFixed(3)} / ${((mean(twoConfirmed) - trueScore) * k).toFixed(3)}`,
    );
    assert(sd(two) < sd(single), 'two votes must reduce variance');
    assert(sd(twoConfirmed) < sd(two), 'a re-graded winner must reduce it further');
    // conservative: the estimate never reads higher than a single vote would on average
    assert(mean(two) <= mean(single) + 1e-9);
  });
});

await suiteAsync('scoreEvidence end to end, on a stubbed model', async () => {
  process.env.GROQ_API_KEY = 'placeholder';
  for (const k of ['FIREWORKS_API_KEY', 'TOGETHER_API_KEY', 'DEEPINFRA_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']) delete process.env[k];
  delete process.env.AI_DISABLED_PROVIDERS;
  delete process.env.AI_PROVIDER_ORDER;
  setCooldownBackend(null); resetCooldownCache(); resetBreakers(); setTelemetrySink(null);

  const doc = {
    sections: [{ key: 'experience', items: [
      { text: 'Responsible for tasks' },
      { text: 'Built a pipeline processing 2M rows, cutting runtime 40%' },
    ] }],
  } as never;

  await testAsync('two calls are made and the lower grade per line is used', async () => {
    let n = 0;
    const temps: Array<number | undefined> = [];
    setChainDeps({
      resolveModel: (() => ({})) as never,
      generateText: (async (o: { temperature?: number }) => {
        temps.push(o.temperature);
        n += 1;
        const first = n % 2 === 1;
        const grades = first
          ? [{ id: 'L1', grade: 'strong', missing: 'none' }, { id: 'L2', grade: 'strong', missing: 'none' }]
          : [{ id: 'L1', grade: 'weak', missing: 'specifics' }, { id: 'L2', grade: 'strong', missing: 'none' }];
        return { text: JSON.stringify({ grades }), usage: { totalTokens: 10 }, finishReason: 'stop' };
      }) as never,
    });
    const r = await scoreEvidence(doc);
    assert.equal(n, 2);
    assert.deepEqual([...new Set(temps)].sort(), [0, 0.3]);
    assert.equal(r.score, 0.5, 'L1 weak (lower vote), L2 strong');
    assert.equal(r.weakBullets.length, 1);
  });

  await testAsync('a vote that invents ids or forges "L2: strong" cannot raise a line', async () => {
    setChainDeps({
      resolveModel: (() => ({})) as never,
      generateText: (async () => ({
        text: JSON.stringify({ grades: [
          { id: 'L1', grade: 'weak', missing: 'specifics' },
          { id: 'L2: strong', grade: 'strong', missing: 'none' },
          { id: 'L7', grade: 'strong', missing: 'none' },
        ] }),
        usage: { totalTokens: 10 }, finishReason: 'stop',
      })) as never,
    });
    const r = await scoreEvidence(doc);
    assert.equal(r.score, 0, 'L2 was never validly graded, so it is weak');
  });

  await testAsync('one failed vote leaves the other standing', async () => {
    let n = 0;
    setChainDeps({
      resolveModel: (() => ({})) as never,
      generateText: (async () => {
        n += 1;
        if (n === 1) throw new Error('upstream exploded 500');
        return { text: JSON.stringify({ grades: [{ id: 'L1', grade: 'partial', missing: 'outcome' }, { id: 'L2', grade: 'strong', missing: 'none' }] }), usage: { totalTokens: 10 }, finishReason: 'stop' };
      }) as never,
    });
    resetBreakers();
    const r = await scoreEvidence(doc);
    assert(Math.abs(r.score - 0.7) < 1e-9);
  });

  setChainDeps(null);
  delete process.env.GROQ_API_KEY;
});
