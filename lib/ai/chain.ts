/**
 * Provider-agnostic AI calls with an ordered fallback chain.
 *
 * REQ: PLAN.md §8 routing (Gemini -> Groq -> DeepInfra -> Together -> Fireworks),
 * NFR-2 / REQ-5.6 budget enforcement, design.md §5 error handling
 * ("all 5 providers fail" must surface an explicit error, never a silent hang).
 */

import { generateObject, generateText, type LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createFireworks } from '@ai-sdk/fireworks';
import { z } from 'zod';

import { availableProviders, type ProviderConfig } from './models';
import { BudgetExceededError, DraftBudget } from './budget';

export class AllProvidersFailedError extends Error {
  constructor(public readonly attempts: Array<{ provider: string; error: string }>) {
    super(
      attempts.length === 0
        ? 'No AI provider is configured. Add at least one provider API key to .env.'
        : `Every configured AI provider failed: ${attempts
            .map((a) => `${a.provider} (${a.error})`)
            .join('; ')}`,
    );
    this.name = 'AllProvidersFailedError';
  }
}

function resolveModel(cfg: ProviderConfig, tier: 'standard' | 'fast'): LanguageModel {
  const apiKey = process.env[cfg.envKey] as string;
  const modelId = tier === 'fast' ? cfg.fastModel : cfg.model;

  switch (cfg.id) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case 'groq':
      return createGroq({ apiKey })(modelId);
    case 'deepinfra':
      return createDeepInfra({ apiKey })(modelId);
    case 'togetherai':
      return createTogetherAI({ apiKey })(modelId);
    case 'fireworks':
      return createFireworks({ apiKey })(modelId);
  }
}

export interface CallOptions {
  /** 'fast' routes to the cheaper model — used by the high-frequency loop calls. */
  tier?: 'standard' | 'fast';
  budget?: DraftBudget;
  temperature?: number;
  maxRetriesPerProvider?: number;
}

interface Attempt {
  provider: string;
  error: string;
}

/**
 * Structured output with fallback. Tries each configured provider in routing order.
 * A budget error is never retried — it's a hard stop, not a provider problem.
 */
export async function generateStructured<T>(args: {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  options?: CallOptions;
}): Promise<{ data: T; provider: string }> {
  const { schema, system, prompt, options = {} } = args;
  const { tier = 'standard', budget, temperature = 0.2 } = options;
  const providers = availableProviders();
  const attempts: Attempt[] = [];

  for (const cfg of providers) {
    budget?.assertCanSpend();

    // Path A — native structured output. Clean when the provider supports it.
    try {
      const result = await generateObject({
        model: resolveModel(cfg, tier),
        schema,
        system,
        prompt,
        temperature,
        maxRetries: options.maxRetriesPerProvider ?? 1,
      });
      budget?.record(result.usage?.totalTokens ?? 0);
      return { data: result.object as T, provider: cfg.label };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      attempts.push({ provider: cfg.label, error: errText(err) });
    }

    // Path B — ask for JSON as text, then parse and validate ourselves.
    //
    // Open-weight models behind DeepInfra/Together/Fireworks frequently don't support
    // JSON-schema response formats, or emit JSON wrapped in prose or a code fence.
    // Rather than treat that as "this provider is broken", we take the text and do the
    // structuring on our side. Zod still validates, so nothing malformed gets through —
    // this widens which models work, it does not weaken the contract.
    budget?.assertCanSpend();
    try {
      const result = await generateText({
        model: resolveModel(cfg, tier),
        system: `${system}\n\nRespond with a single JSON object and nothing else. No prose, no markdown code fence.`,
        prompt: `${prompt}\n\nReturn JSON matching this shape:\n${describeSchema(schema)}`,
        temperature,
        maxRetries: options.maxRetriesPerProvider ?? 1,
      });
      budget?.record(result.usage?.totalTokens ?? 0);

      const parsed = schema.safeParse(extractJson(result.text));
      if (parsed.success) {
        return { data: parsed.data, provider: `${cfg.label} (json)` };
      }
      attempts.push({
        provider: `${cfg.label} (json)`,
        error: parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(', '),
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      attempts.push({ provider: `${cfg.label} (json)`, error: errText(err) });
    }
  }

  throw new AllProvidersFailedError(attempts);
}

/** Pulls the JSON object out of a response that may be fenced or prose-wrapped. */
function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to the outermost {...} span.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** A compact shape hint for models that can't take a real JSON schema. */
function describeSchema(schema: z.ZodType<unknown>): string {
  try {
    // Zod 4 ships JSON Schema conversion; keep it terse so it doesn't eat the prompt.
    const json = z.toJSONSchema(schema as z.ZodType);
    return JSON.stringify(json).slice(0, 4000);
  } catch {
    return '(object)';
  }
}

/** Plain text generation with the same fallback semantics. */
export async function generatePlainText(args: {
  system: string;
  prompt: string;
  options?: CallOptions;
}): Promise<{ text: string; provider: string }> {
  const { system, prompt, options = {} } = args;
  const { tier = 'standard', budget, temperature = 0.3 } = options;
  const providers = availableProviders();
  const attempts: Attempt[] = [];

  for (const cfg of providers) {
    budget?.assertCanSpend();
    try {
      const result = await generateText({
        model: resolveModel(cfg, tier),
        system,
        prompt,
        temperature,
        maxRetries: options.maxRetriesPerProvider ?? 1,
      });
      budget?.record(result.usage?.totalTokens ?? 0);
      return { text: result.text, provider: cfg.label };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      attempts.push({ provider: cfg.label, error: errText(err) });
    }
  }

  throw new AllProvidersFailedError(attempts);
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}
