/**
 * Provider chain configuration.
 *
 * Only providers whose API key is present in the environment are included, so the
 * app runs with whatever subset of keys you have configured.
 *
 * IMPORTANT: providers retire model IDs on a regular cadence. Every model id below is
 * overridable by env var precisely so a retirement is a config change, not a code
 * change. If a call starts failing with a model-not-found error, set the matching
 * *_MODEL variable rather than editing this file. All ten ids here were checked against
 * each provider's own model listing on 2026-09-10 and were live.
 *
 * ORDER AND CAPABILITY ARE MEASURED, NOT ASSUMED — see the table below. The original
 * order came from PLAN.md §8 (Gemini -> Groq -> DeepInfra -> Together -> Fireworks) and
 * was written before any provider had been timed. Measured against the real intake
 * schema and a real posting, it turned out to be close to the inverse of what works, and
 * that is why production drafting failed: the chain spent its entire budget on the three
 * slowest or deadest providers and never reached the two that answer in seconds.
 *
 *   provider    path A (native structured)      path B (JSON as text)
 *   Fireworks   OK    3.6s                      OK    3.7s
 *   Groq        rejects our schema, 0.1s        OK    1.9s
 *   Together    unsupported, 5.1s wasted        OK    15.4s
 *   DeepInfra   OK   30.4s                      "Model busy"
 *   Gemini      hangs to the attempt cap        quota exhausted, 0.9s
 */

export type ProviderId = 'google' | 'groq' | 'deepinfra' | 'togetherai' | 'fireworks';

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  envKey: string;
  /** Model used for reasoning-heavy calls (extraction, rewrite, critique). */
  model: string;
  /** Cheaper/faster model for high-frequency loop calls (evidence judging). */
  fastModel: string;
  /**
   * Whether asking this provider for native structured output can ever work.
   *
   * False is not a guess and not a degradation — it is a measured, structural fact about
   * the provider, and the chain uses it to skip a request that is certain to fail. Both
   * providers marked false answer the text path perfectly well, so nothing is lost but
   * the wasted round trip.
   */
  structuredOutput: boolean;
}

/**
 * Ordered by measured reliability, fastest working path first.
 *
 * The order is overridable with AI_PROVIDER_ORDER (comma-separated ids) so that a quota
 * reset, a new key, or a provider having a bad day is a config change rather than a
 * deploy — the same reasoning as the model ids above, applied to the routing.
 */
export const PROVIDER_CHAIN: ProviderConfig[] = [
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    // First because it is the only provider measured to serve native structured output
    // in a time a 20-second draft can afford: 3.6s, against DeepInfra's 30.4s.
    model:
      process.env.FIREWORKS_MODEL ?? 'accounts/fireworks/models/gpt-oss-120b',
    /*
     * The same model as the standard tier, because it is measured to be the fastest
     * thing Fireworks serves — not a compromise.
     *
     * The fast tier exists for the evidence judge, which runs many times per draft, so a
     * second here is multiplied by the loop. The model named here was
     * deepseek-v4-flash-0731 on the reasonable assumption that a model called "flash" is
     * quick; judged warm, on the judge's own tiny prompt, it takes 1.8-2.0s against
     * gpt-oss-120b's 1.0-1.2s. glm-5p3-flash is worse again at 2.7-4.3s. A name is not a
     * measurement.
     */
    fastModel:
      process.env.FIREWORKS_FAST_MODEL ?? 'accounts/fireworks/models/gpt-oss-120b',
    structuredOutput: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    model: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
    fastModel: process.env.GROQ_FAST_MODEL ?? 'openai/gpt-oss-20b',
    /*
     * Groq requires `required` to name every key in `properties`. Zod omits optional
     * fields from `required`, and JobSchema has three, so every native structured call
     * to Groq fails with "invalid JSON schema for response_format" — permanently, for
     * every schema in this app that has an optional field.
     *
     * The fix is NOT to make the schemas all-required: that changes what every provider
     * is asked for, to satisfy one. Nor can it be a Zod transform — the AI SDK converts
     * with `io: "input"`, where a preprocess emits `{}` and a transform cannot be
     * represented at all (the reasoning is spelled out on JobSchema in
     * lib/intake/extract.ts). So the honest answer is that Groq does not support this
     * schema shape, and the chain should ask it the way it can answer: 1.9s on the text
     * path, the fastest working call of any provider here.
     */
    structuredOutput: false,
  },
  {
    id: 'togetherai',
    label: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    model: process.env.TOGETHER_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro-0813',
    fastModel:
      process.env.TOGETHER_FAST_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash-0731',
    // The SDK says it outright — "responseFormat is not supported; JSON response format
    // schema is only supported with structuredOutputs" — but only after the request has
    // been made and 5.1 seconds spent. Skipping it outright is worth more here than
    // anywhere else in this list.
    structuredOutput: false,
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    envKey: 'DEEPINFRA_API_KEY',
    model: process.env.DEEPINFRA_MODEL ?? 'deepseek-ai/DeepSeek-V3.2',
    // Measured: Qwen3.5-35B-A3B took 36s here (cold/slow), which is disastrous for the
    // per-iteration evidence judge. The 'standard' model measured 1.7s, so it doubles
    // as the fast tier until something reliably quicker is verified.
    fastModel: process.env.DEEPINFRA_FAST_MODEL ?? 'deepseek-ai/DeepSeek-V3.2',
    // It does work — in 30.4 seconds, which is longer than a whole draft is allowed to
    // take. Kept as a late fallback rather than removed: on a caller with a generous
    // deadline (the importer, the sync) a slow answer still beats no answer.
    structuredOutput: true,
  },
  {
    id: 'google',
    label: 'Gemini',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    // Google's floating aliases rather than a pinned version. Pinned Gemini IDs get
    // retired on a schedule — gemini-2.0-flash was already dead by the first run —
    // and this is the one provider that publishes an alias that follows the current
    // model, so the alias is strictly less brittle than any version we could pin.
    model: process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
    fastModel: process.env.GEMINI_FAST_MODEL ?? 'gemini-flash-lite-latest',
    /*
     * Last, having been first, because the key's free-tier quota is exhausted — and the
     * way it reports that is what made it expensive. The text path answers "You exceeded
     * your current quota" in 0.9s; the structured path simply never returns, and is
     * killed by the attempt cap having said nothing at all. At the front of the chain
     * that is 10 of the intake's 13 seconds spent learning nothing, every draft, which
     * is most of why no draft completed.
     *
     * It stays in the chain because a free-tier quota is a daily thing, not a permanent
     * one, and the cooldown store benches it in the meantime. If the quota is raised or
     * billing is enabled, moving it back up is AI_PROVIDER_ORDER, not a deploy.
     */
    structuredOutput: true,
  },
];

/**
 * The chain in routing order, honouring AI_PROVIDER_ORDER when it is set.
 *
 * Unknown ids in the variable are ignored and configured providers it omits keep their
 * relative order at the back, so a typo or a half-written list degrades to "roughly the
 * default" rather than to a chain with providers silently missing from it.
 */
function orderedChain(): ProviderConfig[] {
  const raw = process.env.AI_PROVIDER_ORDER;
  if (!raw?.trim()) return PROVIDER_CHAIN;

  const wanted = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const front = wanted
    .map((id) => PROVIDER_CHAIN.find((p) => p.id === id))
    .filter((p): p is ProviderConfig => p !== undefined);

  return [...front, ...PROVIDER_CHAIN.filter((p) => !front.includes(p))];
}

/** Providers that actually have a key configured, in routing order. */
export function availableProviders(): ProviderConfig[] {
  return orderedChain().filter((p) => {
    const v = process.env[p.envKey];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

export function hasAnyProvider(): boolean {
  return availableProviders().length > 0;
}
