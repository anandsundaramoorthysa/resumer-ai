/**
 * Provider chain configuration.
 *
 * Routing order (PLAN.md §8): Gemini -> Groq -> DeepInfra -> Together -> Fireworks.
 * Only providers whose API key is present in the environment are included, so the
 * app runs with whatever subset of keys you have configured.
 *
 * IMPORTANT (per PLAN.md): Groq retires model IDs on a regular cadence. Every model
 * id below is overridable by env var precisely so a retirement is a config change,
 * not a code change. If a Groq call starts failing with a model-not-found error,
 * update GROQ_MODEL rather than editing this file.
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
}

/** Ordered by preference. First configured provider wins; the rest are fallbacks. */
export const PROVIDER_CHAIN: ProviderConfig[] = [
  {
    id: 'google',
    label: 'Gemini',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
    fastModel: process.env.GEMINI_FAST_MODEL ?? 'gemini-2.0-flash-lite',
  },
  {
    id: 'groq',
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
    fastModel: process.env.GROQ_FAST_MODEL ?? 'llama-3.1-8b-instant',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    envKey: 'DEEPINFRA_API_KEY',
    model: process.env.DEEPINFRA_MODEL ?? 'deepseek-ai/DeepSeek-V3.2',
    fastModel: process.env.DEEPINFRA_FAST_MODEL ?? 'Qwen/Qwen3.5-35B-A3B',
  },
  {
    id: 'togetherai',
    label: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    model: process.env.TOGETHER_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro-0813',
    fastModel:
      process.env.TOGETHER_FAST_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash-0731',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    model:
      process.env.FIREWORKS_MODEL ?? 'accounts/fireworks/models/gpt-oss-120b',
    fastModel:
      process.env.FIREWORKS_FAST_MODEL ??
      'accounts/fireworks/models/deepseek-v4-flash-0731',
  },
];

/** Providers that actually have a key configured, in routing order. */
export function availableProviders(): ProviderConfig[] {
  return PROVIDER_CHAIN.filter((p) => {
    const v = process.env[p.envKey];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

export function hasAnyProvider(): boolean {
  return availableProviders().length > 0;
}
