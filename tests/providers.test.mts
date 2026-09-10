/**
 * The provider chain — lib/ai/models.ts.
 *
 * Production drafting failed for days because this list was in the wrong order and two of
 * its five entries were being asked a question they structurally cannot answer. Neither
 * fault was visible: every model id was live, every key was set, and the chain reported
 * only "every configured AI provider failed".
 *
 * What is pinned here is what measurement bought — the order, and which providers may be
 * asked for native structured output. Both are the kind of fact a later edit reverts
 * without noticing, because reverting them breaks nothing locally and everything on a
 * 20-second function.
 */

import { availableProviders, PROVIDER_CHAIN, type ProviderId } from '../lib/ai/models';
import { suite, test, assert } from './harness.mjs';

const KEYS = [
  'FIREWORKS_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'DEEPINFRA_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
];

/** Runs `fn` with exactly the given environment applied over a cleared provider env. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of [...KEYS, 'AI_PROVIDER_ORDER']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const allKeys = Object.fromEntries(KEYS.map((k) => [k, 'test-key']));
const ids = (list: { id: ProviderId }[]) => list.map((p) => p.id);

suite('routing order', () => {
  test('the fastest measured working provider is asked first', () => {
    // Fireworks: the only provider measured to serve native structured output inside a
    // draft's budget (3.6s). It was last in the original order.
    assert.equal(PROVIDER_CHAIN[0].id, 'fireworks');
  });

  test('the quota-exhausted provider is asked last, not first', () => {
    // Gemini was first. Its structured path returns nothing at all and is killed by the
    // attempt cap, which cost every draft ~10 of its ~13 second intake budget.
    assert.equal(PROVIDER_CHAIN[PROVIDER_CHAIN.length - 1].id, 'google');
  });

  test('the 30-second provider is not asked before the 4-second ones', () => {
    const chain = ids(PROVIDER_CHAIN);
    assert.ok(chain.indexOf('deepinfra') > chain.indexOf('fireworks'));
    assert.ok(chain.indexOf('deepinfra') > chain.indexOf('groq'));
  });

  test('every provider appears exactly once', () => {
    const chain = ids(PROVIDER_CHAIN);
    assert.equal(new Set(chain).size, chain.length);
    assert.equal(chain.length, 5);
  });
});

suite('which providers may be asked for native structured output', () => {
  const by = (id: ProviderId) => PROVIDER_CHAIN.find((p) => p.id === id)!;

  test('Groq may not — it rejects any schema with an optional field', () => {
    assert.equal(by('groq').structuredOutput, false);
  });

  test('Together may not — the SDK reports the feature unsupported, after 5.1s', () => {
    assert.equal(by('togetherai').structuredOutput, false);
  });

  test('the providers that answered it are still allowed to', () => {
    assert.equal(by('fireworks').structuredOutput, true);
    assert.equal(by('deepinfra').structuredOutput, true);
    assert.equal(by('google').structuredOutput, true);
  });

  test('at least one provider can serve it, or nothing structured could ever succeed', () => {
    assert.ok(PROVIDER_CHAIN.some((p) => p.structuredOutput));
  });
});

suite('only configured providers are routed to', () => {
  test('a provider with no key is not in the chain', () => {
    withEnv({ FIREWORKS_API_KEY: 'k' }, () => {
      assert.deepEqual(ids(availableProviders()), ['fireworks']);
    });
  });

  test('an empty or whitespace key does not count as configured', () => {
    withEnv({ FIREWORKS_API_KEY: '   ', GROQ_API_KEY: 'k' }, () => {
      assert.deepEqual(ids(availableProviders()), ['groq']);
    });
  });

  test('with every key set, the full measured order is used', () => {
    withEnv(allKeys, () => {
      assert.deepEqual(ids(availableProviders()), [
        'fireworks',
        'groq',
        'togetherai',
        'deepinfra',
        'google',
      ]);
    });
  });
});

suite('AI_PROVIDER_ORDER — re-routing without a deploy', () => {
  test('names the providers to try first', () => {
    withEnv({ ...allKeys, AI_PROVIDER_ORDER: 'groq,google' }, () => {
      assert.deepEqual(ids(availableProviders()).slice(0, 2), ['groq', 'google']);
    });
  });

  test('providers it omits are kept, in their default order, behind the named ones', () => {
    withEnv({ ...allKeys, AI_PROVIDER_ORDER: 'google' }, () => {
      assert.deepEqual(ids(availableProviders()), [
        'google',
        'fireworks',
        'groq',
        'togetherai',
        'deepinfra',
      ]);
    });
  });

  test('a typo is ignored rather than dropping a working provider', () => {
    // The failure this guards: a chain silently one provider short is the exact shape of
    // the outage this whole change is about.
    withEnv({ ...allKeys, AI_PROVIDER_ORDER: 'grok,fireworks' }, () => {
      const routed = ids(availableProviders());
      assert.equal(routed[0], 'fireworks');
      assert.equal(routed.length, 5);
    });
  });

  test('whitespace and casing in the variable are tolerated', () => {
    withEnv({ ...allKeys, AI_PROVIDER_ORDER: ' GROQ , Fireworks ' }, () => {
      assert.deepEqual(ids(availableProviders()).slice(0, 2), ['groq', 'fireworks']);
    });
  });

  test('an empty variable is the same as not setting it', () => {
    withEnv({ ...allKeys, AI_PROVIDER_ORDER: '  ' }, () => {
      assert.deepEqual(ids(availableProviders()), ids(PROVIDER_CHAIN));
    });
  });
});
