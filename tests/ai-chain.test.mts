/**
 * The provider chain's production behaviour — lib/ai/chain.ts, breaker.ts, models.ts.
 *
 * The SDK is replaced through `setChainDeps`; no provider is ever contacted and the keys set
 * below are placeholders.
 */

delete process.env.DATABASE_URL;

import { z } from 'zod';
import { NoObjectGeneratedError } from 'ai';
import {
  AllProvidersFailedError,
  benchReason,
  generatePlainText,
  generateStructured,
  modelGoneProviders,
  setChainDeps,
  setModelGoneReporter,
  setBreakerClock, resetBreakers, breakerAllows, breakerFailure, breakerSuccess,
  setCooldownBackend, resetCooldownCache, setTelemetrySink,
} from '../lib/ai/chain';
import { availableProviders, describeModelConfig } from '../lib/ai/models';
import { DraftBudget, estimateTokens, tokensFor } from '../lib/ai/budget';
import type { AiCallRow } from '../lib/ai/telemetry';
import { suite, suiteAsync, test, testAsync, assert } from './harness.mjs';

const KEYS = ['GROQ_API_KEY', 'FIREWORKS_API_KEY', 'TOGETHER_API_KEY', 'DEEPINFRA_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'];
function env(keys: string[], extra: Record<string, string | undefined> = {}) {
  for (const k of KEYS) delete process.env[k];
  for (const k of keys) process.env[k] = 'placeholder';
  delete process.env.AI_DISABLED_PROVIDERS;
  delete process.env.AI_PII_PROVIDERS;
  delete process.env.AI_PROVIDER_ORDER;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
function reset() {
  setCooldownBackend(null);
  resetCooldownCache();
  resetBreakers();
  setBreakerClock(undefined);
  setModelGoneReporter(() => {});
}

const Schema = z.object({ ok: z.boolean() });
const rows: AiCallRow[] = [];
setTelemetrySink((r) => void rows.push(r));

interface Call { provider: string; kind: 'object' | 'text'; maxOutputTokens?: number; prompt: string; seed?: number }
function install(script: (c: Call) => unknown) {
  const calls: Call[] = [];
  const run = (kind: 'object' | 'text') => async (o: { model: { provider: string }; maxOutputTokens?: number; prompt: string; seed?: number }) => {
    const c: Call = { provider: o.model.provider, kind, maxOutputTokens: o.maxOutputTokens, prompt: o.prompt, seed: o.seed };
    calls.push(c);
    const r = script(c);
    if (r instanceof Error) throw r;
    return r;
  };
  setChainDeps({
    generateObject: run('object') as never,
    generateText: run('text') as never,
    resolveModel: ((cfg: { id: string }) => ({ provider: cfg.id })) as never,
  });
  return calls;
}
const okText = (usage: unknown = { totalTokens: 10 }) => ({ text: '{"ok":true}', usage, finishReason: 'stop' });
const okObject = (usage: unknown = { totalTokens: 10 }) => ({ object: { ok: true }, usage, finishReason: 'stop' });

await suiteAsync('output cap reaches both provider paths', async () => {
  await testAsync('structured and json-as-text paths both get maxOutputTokens', async () => {
    reset(); env(['GROQ_API_KEY', 'FIREWORKS_API_KEY']);
    const calls = install(() => okText());
    await generateStructured({ schema: Schema, system: 's', prompt: 'p', options: { maxOutputTokens: 777 } });
    assert.equal(calls[0].provider, 'groq');
    assert.equal(calls[0].kind, 'text');
    assert.equal(calls[0].maxOutputTokens, 777);

    reset(); env(['FIREWORKS_API_KEY']);
    const c2 = install(() => okObject());
    await generateStructured({ schema: Schema, system: 's', prompt: 'p', options: { maxOutputTokens: 555 } });
    assert.equal(c2[0].kind, 'object');
    assert.equal(c2[0].maxOutputTokens, 555);
  });

  await testAsync('a call that states no cap still gets one', async () => {
    reset(); env(['GROQ_API_KEY']);
    const calls = install(() => ({ text: 'hi', usage: { totalTokens: 3 }, finishReason: 'stop' }));
    await generatePlainText({ system: 's', prompt: 'p' });
    assert(typeof calls[0].maxOutputTokens === 'number' && calls[0].maxOutputTokens > 0);
  });
});

await suiteAsync('truncation is not a schema failure', async () => {
  await testAsync('without a shrink hook it falls through and is recorded as truncated', async () => {
    reset(); env(['GROQ_API_KEY', 'FIREWORKS_API_KEY']); rows.length = 0;
    const calls = install((c) =>
      c.provider === 'groq' ? { text: '{"ok":tr', usage: { totalTokens: 50 }, finishReason: 'length' } : okObject(),
    );
    const r = await generateStructured({ schema: Schema, system: 's', prompt: 'p' });
    assert.equal(r.provider, 'Fireworks AI');
    assert.equal(calls.filter((c) => c.provider === 'groq').length, 1, 'no retry on the truncating provider');
    assert(rows.some((x) => x.provider === 'groq' && x.errorClass === 'truncated' && x.finishReason === 'length'), JSON.stringify(rows));
  });

  await testAsync('with a shrink hook it retries ONCE on the same provider with the smaller input', async () => {
    reset(); env(['GROQ_API_KEY']);
    const calls = install((c) =>
      c.prompt.includes('SMALL') ? okText() : { text: '{"ok', usage: { totalTokens: 5 }, finishReason: 'length' },
    );
    const r = await generateStructured({
      schema: Schema, system: 's', prompt: 'BIG',
      options: { maxOutputTokens: 100, shrink: () => ({ prompt: 'SMALL', maxOutputTokens: 200 }) },
    });
    assert.equal(r.data.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].maxOutputTokens, 200);
  });

  await testAsync('a structured-path truncation (NoObjectGeneratedError, length) is recognised', async () => {
    reset(); env(['FIREWORKS_API_KEY']); rows.length = 0;
    install(() => new NoObjectGeneratedError({
      message: 'cut', text: '{"ok', response: { id: 'x', timestamp: new Date(), modelId: 'm' } as never,
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } as never, finishReason: 'length',
    }));
    try { await generateStructured({ schema: Schema, system: 's', prompt: 'p' }); assert.fail('should throw'); }
    catch (e) { assert(e instanceof AllProvidersFailedError); }
    assert(rows.some((x) => x.path === 'structured' && x.errorClass === 'truncated'));
    // truncation is the caller's sizing: it must not feed the breaker
    assert(breakerAllows('fireworks'));
  });
});

suite('retired model ids are loud', () => {
  test('404 and retirement wording classify as model-gone', () => {
    for (const m of [
      'Error 404: not found', 'model_not_found', 'The model `x` does not exist', 'model has been decommissioned',
      'This model is deprecated', 'the model has been retired', 'models/foo is not found for API version v1beta',
    ]) assert.equal(benchReason(m), 'model-gone', m);
  });
  test('false friends do not', () => {
    assert.equal(benchReason('prompt used 4041 tokens'), null);
    assert.equal(benchReason('field "legacy" is deprecated in the schema'), null);
  });
});

await suiteAsync('model-gone benches long, reports once, surfaces in the getter', async () => {
  await testAsync('reported once per hour per provider; other provider answers', async () => {
    reset(); env(['GROQ_API_KEY', 'FIREWORKS_API_KEY']);
    const msgs: string[] = [];
    setModelGoneReporter((m) => void msgs.push(m));
    install((c) => (c.provider === 'groq' ? new Error('The model `openai/gpt-oss-120b` does not exist (404)') : okObject()));
    await generateStructured({ schema: Schema, system: 's', prompt: 'p' });
    assert.deepEqual(modelGoneProviders(), ['groq']);
    assert.equal(msgs.length, 1);
    assert(msgs[0].includes('GROQ_MODEL') && msgs[0].includes('appears retired'));
    // a second failing call for the same provider (forced past the bench) does not report again
    resetCooldownCache();
    await generateStructured({ schema: Schema, system: 's', prompt: 'p' });
    assert.equal(msgs.length, 1);
  });
});

suite('circuit breaker', () => {
  test('opens after 3, half-opens after 30s with one probe, success closes', () => {
    resetBreakers();
    let t = 1_000;
    setBreakerClock(() => t);
    assert.equal(breakerFailure('groq'), false);
    assert.equal(breakerFailure('groq'), false);
    assert.equal(breakerFailure('groq'), true);
    assert.equal(breakerAllows('groq'), false);
    t += 29_000;
    assert.equal(breakerAllows('groq'), false);
    t += 2_000;
    assert.equal(breakerAllows('groq'), true, 'one probe');
    assert.equal(breakerAllows('groq'), false, 'only one');
    assert.equal(breakerFailure('groq'), true, 'a failed probe re-opens at once');
    assert.equal(breakerAllows('groq'), false);
    t += 31_000;
    assert.equal(breakerAllows('groq'), true);
    breakerSuccess('groq');
    assert.equal(breakerAllows('groq'), true);
    assert.equal(breakerAllows('groq'), true);
    setBreakerClock(undefined);
  });

  test('threshold and window are env-overridable', () => {
    resetBreakers();
    process.env.AI_BREAKER_THRESHOLD = '1';
    setBreakerClock(() => 0);
    assert.equal(breakerFailure('x'), true);
    delete process.env.AI_BREAKER_THRESHOLD;
    setBreakerClock(undefined);
  });
});

await suiteAsync('a chain of failing providers fails fast', async () => {
  await testAsync('after repeated failures every provider is open and the call does not touch the SDK', async () => {
    reset(); env(['GROQ_API_KEY', 'FIREWORKS_API_KEY']);
    let t = 5_000;
    setBreakerClock(() => t);
    const calls = install(() => new Error('upstream exploded 500'));
    for (let i = 0; i < 3; i++) {
      try { await generateStructured({ schema: Schema, system: 's', prompt: 'p', options: { maxRetriesPerProvider: 0 } }); } catch { /* expected */ }
      resetCooldownCache(); // the DB mirror is separate; here the breaker is what is under test
    }
    const before = calls.length;
    const started = Date.now();
    try { await generateStructured({ schema: Schema, system: 's', prompt: 'p', options: { deadlineMs: 60_000 } }); assert.fail('should throw'); }
    catch (e) {
      assert(e instanceof AllProvidersFailedError);
      assert(String((e as Error).message).includes('circuit open'));
    }
    assert.equal(calls.length, before, 'no provider was asked');
    assert(Date.now() - started < 500);
    // 31s later a probe goes out and a success closes the breaker
    t += 31_000;
    resetCooldownCache();
    install(() => okObject());
    const r = await generateStructured({ schema: Schema, system: 's', prompt: 'p' });
    assert.equal(r.data.ok, true);
    setBreakerClock(undefined);
  });
});

suite('provider allow-list', () => {
  test('AI_DISABLED_PROVIDERS removes providers, with aliases, read at call time', () => {
    env(['GROQ_API_KEY', 'FIREWORKS_API_KEY', 'TOGETHER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']);
    assert.deepEqual(availableProviders().map((p) => p.id), ['groq', 'fireworks', 'togetherai', 'google']);
    process.env.AI_DISABLED_PROVIDERS = 'google, together';
    assert.deepEqual(availableProviders().map((p) => p.id), ['groq', 'fireworks']);
    delete process.env.AI_DISABLED_PROVIDERS;
    assert.equal(availableProviders().length, 4);
  });

  test('AI_PII_PROVIDERS only restricts calls flagged containsPii', () => {
    env(['GROQ_API_KEY', 'FIREWORKS_API_KEY', 'TOGETHER_API_KEY']);
    assert.equal(availableProviders({ containsPii: true }).length, 3, 'unset = all');
    process.env.AI_PII_PROVIDERS = 'fireworks';
    assert.deepEqual(availableProviders({ containsPii: true }).map((p) => p.id), ['fireworks']);
    assert.equal(availableProviders().length, 3, 'unflagged prompts are not restricted');
    delete process.env.AI_PII_PROVIDERS;
  });
});

await suiteAsync('the chain honours the allow-lists', async () => {
  await testAsync('a PII call never reaches a provider outside AI_PII_PROVIDERS', async () => {
    reset(); env(['GROQ_API_KEY', 'FIREWORKS_API_KEY'], { AI_PII_PROVIDERS: 'fireworks' });
    const calls = install(() => okObject());
    await generateStructured({ schema: Schema, system: 's', prompt: 'p', options: { containsPii: true } });
    assert(calls.every((c) => c.provider === 'fireworks'));
    env([]);
  });
});

suite('token accounting', () => {
  test('missing or zero usage is estimated at ceil(chars / 3.5)', () => {
    assert.equal(tokensFor(undefined, 700, 350).total, Math.ceil(1050 / 3.5));
    assert.equal(tokensFor({ totalTokens: 0 }, 35, 0).total, 10);
    assert.equal(tokensFor({ totalTokens: 123 }, 10, 10).total, 123);
    assert.equal(estimateTokens(7), 2);
  });
});

await suiteAsync('the budget sees every attempt', async () => {
  await testAsync('success with no usage is estimated, a failed attempt costs its prompt', async () => {
    reset(); env(['GROQ_API_KEY', 'FIREWORKS_API_KEY']); rows.length = 0;
    const calls = install((c) => (c.provider === 'groq' ? new Error('boom') : { object: { ok: true }, finishReason: 'stop' }));
    const budget = new DraftBudget();
    await generateStructured({ schema: Schema, system: 'x'.repeat(350), prompt: 'y'.repeat(350), options: { budget, maxRetriesPerProvider: 0 } });
    const snap = budget.snapshot();
    assert.equal(snap.calls, 2);
    assert(snap.tokens >= estimateTokens(700), `tokens ${snap.tokens}`);
    assert(calls.length >= 2);
    assert(rows.every((r) => r.inTokens > 0));
    assert(rows.some((r) => r.errorClass === 'error') && rows.some((r) => r.errorClass === null));
  });
});

await suiteAsync('telemetry never breaks a call and carries no prompt text', async () => {
  await testAsync('a throwing sink is swallowed', async () => {
    reset(); env(['GROQ_API_KEY']);
    setTelemetrySink(() => { throw new Error('sink down'); });
    install(() => okText());
    const r = await generateStructured({ schema: Schema, system: 's', prompt: 'SECRET-PROMPT', options: { telemetry: { stage: 't', promptVersion: '1.0' } } });
    assert.equal(r.data.ok, true);
    setTelemetrySink((r2) => void rows.push(r2));
  });

  await testAsync('rows hold sizes and labels, not text', async () => {
    reset(); env(['GROQ_API_KEY']); rows.length = 0;
    install(() => okText());
    await generateStructured({ schema: Schema, system: 's', prompt: 'SECRET-PROMPT', options: { telemetry: { stage: 'judge', promptVersion: '1.0', userId: 'u1' } } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stage, 'judge');
    assert.equal(rows[0].promptVersion, '1.0');
    assert(!JSON.stringify(rows[0]).includes('SECRET-PROMPT'));
  });
});

suite('model config self-check', () => {
  test('reports env vs default and never a key', () => {
    env(['GROQ_API_KEY'], { GROQ_MODEL: 'custom/model' });
    const d = describeModelConfig();
    const g = d.find((x) => x.provider === 'groq')!;
        assert.equal(g.models.standard.source, 'env');
    assert.equal(g.models.fast.source, 'default');
    assert.equal(g.keyConfigured, true);
    assert(!JSON.stringify(d).includes('placeholder'));
    delete process.env.GROQ_MODEL;
  });
});
