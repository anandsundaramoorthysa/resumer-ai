/**
 * Provider-agnostic AI calls with an ordered fallback chain.
 *
 * REQ: NFR-2 / REQ-5.6 budget enforcement, design.md §5 error handling
 * ("all 5 providers fail" must surface an explicit error, never a silent hang).
 *
 * Routing order lives in ./models.ts and is now measured rather than declared — PLAN.md
 * §8's order (Gemini -> Groq -> DeepInfra -> Together -> Fireworks) was written before
 * any provider had been timed, and proved to be close to the inverse of what works. The
 * table there has the measurements and the reasoning.
 */

import { generateObject, generateText, type LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createFireworks } from '@ai-sdk/fireworks';
import { z } from 'zod';

import { availableProviders, type ProviderConfig, type ProviderId } from './models';
import { BudgetExceededError, DraftBudget } from './budget';
import {
  isCoolingDown,
  loadCooldowns,
  noteBench,
  type BenchReason,
} from './cooldowns';

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
  /**
   * Per-attempt wall-clock cap. Without one, a single slow provider can consume the
   * whole request budget while four healthy fallbacks sit unused — measured as the
   * dominant cost in portfolio extraction. Abandoning a slow attempt and moving to the
   * next provider is almost always faster than waiting it out.
   */
  timeoutMs?: number;
  /**
   * Wall-clock cap for the WHOLE call, across every provider and both paths.
   *
   * A per-attempt cap alone doesn't bound anything useful: five providers times two
   * paths times a 25s attempt is over four minutes, and portfolio extraction measured
   * exactly that shape — single steps of 140s and 122s while the caller only had ten
   * seconds to give. Callers that run inside a request have a real deadline, so they
   * state it here and the chain stops trying rather than overrunning it.
   */
  deadlineMs?: number;
}

// 10s, what production runs with. 25s — most of a 30s function on one provider — was the
// default wherever AI_ATTEMPT_TIMEOUT_MS was not set.
export const DEFAULT_ATTEMPT_TIMEOUT_MS = Number(
  process.env.AI_ATTEMPT_TIMEOUT_MS ?? 10_000,
);

interface Attempt {
  provider: string;
  error: string;
}

/**
 * Short-lived cooldown for providers that report quota, overload or a timeout.
 *
 * Without this, an exhausted provider sitting at the front of the chain is retried on
 * every single call — measured as the dominant cost once a free tier ran out, because
 * each doomed attempt burned its full timeout before falling through. A provider that
 * just told us it's out of quota will still be out of quota a second later, so we skip
 * it for a while instead of asking again.
 *
 * The map that held this used to live here, in module memory, and that is why the fix
 * kept not working on Netlify: the memory dies with the instance, so every cold
 * invocation started with an empty map and paid the full lesson again. Measured this
 * week, every single draft spent 4-13 of its 20-second budget on an overloaded Gemini
 * before falling through. It lives in lib/ai/cooldowns.ts now, backed by a table, so one
 * instance learning a provider is down spares the rest. What is kept here is only the
 * decision of WHICH failures bench — `benchReason` below, which is pure and tested.
 */

/** The smallest attempt worth starting; below this a call cannot realistically land. */
const MIN_ATTEMPT_MS = 800;

const QUOTA_SIGNATURES = [
  'exceeded your current quota',
  'rate limit',
  'rate_limit',
  'too many requests',
  'quota',
  'insufficient_quota',
  'resource_exhausted',
];

/** A status code, not any run of digits: "Received 4297.2" benched all five providers. */
const STATUS_429 = /(?<!\d)429(?!\d)/;

/**
 * A fault on this side, which says nothing about the provider.
 *
 * Benching on one costs every provider at once — measured: a fractional millisecond passed
 * to AbortSignal.timeout made all five fail in the same eight milliseconds, and the message
 * "Received 4297.2" was read as an HTTP 429 by the rule above, so the whole chain sat out a
 * five-minute cooldown for a bug of ours.
 */
const LOCAL_FAULT = /out of range|is not a function|cannot read propert|not iterable|invalid_type/i;

function isQuotaError(message: string): boolean {
  const m = message.toLowerCase();
  return QUOTA_SIGNATURES.some((s) => m.includes(s)) || STATUS_429.test(m);
}

const TIMEOUT_SIGNATURES = [
  'aborted',
  'abort',
  'timeout',
  'timed out',
  'etimedout',
];

function isTimeoutError(message: string): boolean {
  const m = message.toLowerCase();
  return TIMEOUT_SIGNATURES.some((s) => m.includes(s));
}

/**
 * A provider saying it is overloaded — a 503, in its own words.
 *
 * This was the gap. In production the first provider answered every structured call
 * with "This model is currently experiencing high demand. Spikes in demand are usually
 * temporary. Please try again later." — and that is neither a quota error nor a timeout,
 * so nothing benched it. The chain concluded the provider had merely been unlucky and
 * asked it again through the text path, that second attempt spent the rest of the
 * deadline, and the provider that would have answered in three seconds was never reached.
 * Every draft on a 30-second function failed that way.
 *
 * The signatures are deliberately specific. A bare "503" or "unavailable" would also
 * match a token count or an unrelated message, and a false match benches a healthy
 * provider — the same failure, pointed the other way.
 */
const OVERLOAD_SIGNATURES = [
  'high demand',
  'overloaded',
  'try again later',
  'service unavailable',
  'temporarily unavailable',
];

function isOverloadError(message: string): boolean {
  const m = message.toLowerCase();
  return OVERLOAD_SIGNATURES.some((s) => m.includes(s));
}

/**
 * Re-exported from ./cooldowns, where the store that acts on it now lives. Importers of
 * this type from lib/ai/chain — and the suite that pins `benchReason` — keep working.
 */
export type { BenchReason };

/**
 * Why a failure should bench its provider — or null when it says nothing about the
 * provider's health at all.
 *
 * Pure and exported so the decision can be pinned by a test; noteFailure below only
 * applies it. That this was not testable is how a 503 went unrecognised: nothing
 * exercised the classification, so nothing noticed a whole class was missing.
 *
 * An overload benches even when our deadline cut the attempt short. `cutShort` exists so
 * a tight budget cannot slowly bench every provider on timeouts it caused itself — but
 * an overload is the provider telling us, not our clock.
 *
 * @param cutShort true when the caller's overall deadline, not the provider, ended the
 * attempt. That says nothing about the provider's health, so it must not earn a
 * cooldown — otherwise a tight budget would slowly bench every provider we have.
 */
export function benchReason(message: string, cutShort = false): BenchReason | null {
  if (LOCAL_FAULT.test(message)) return null;
  if (isQuotaError(message)) return 'quota';
  if (isOverloadError(message)) return 'overload';
  if (!cutShort && isTimeoutError(message)) return 'slow';
  return null;
}

function noteFailure(id: ProviderId, message: string, cutShort = false): boolean {
  const reason = benchReason(message, cutShort);
  if (!reason) return false;
  // Quota gets the longer cooldown; overload — "usually temporary" in the provider's own
  // words — and slow get the shorter one. noteBench applies that and, unlike the Map this
  // replaced, tells the other instances.
  noteBench(id, reason);
  return true;
}

/**
 * How long the next attempt may take: the smaller of the per-attempt cap and whatever
 * is left of the caller's overall deadline — and, while there is another provider to
 * fall back to, a share of what is left rather than all of it.
 */
export function attemptWindow(
  deadlineAt: number,
  perAttemptMs: number,
): { ms: number; viable: boolean; cutShort: boolean } {
  const left = deadlineAt - Date.now();
  // Whole milliseconds: AbortSignal.timeout refuses a fraction outright ("The value of
  // 'delay' is out of range… Received 4297.2" — measured, when a proportional window was
  // tried here, as all five providers failing in the same eight milliseconds).
  const ms = Math.floor(Math.min(perAttemptMs, left));
  return { ms, viable: ms >= MIN_ATTEMPT_MS, cutShort: left < perAttemptMs };
}

/**
 * Providers that are configured and not currently cooling down.
 *
 * Synchronous, and reads only this process's memory. `loadCooldowns()` is what brings
 * that memory up to date with the other instances, and it is awaited once per call —
 * see the note where it is called. Exported so a verification script can show the chain
 * skipping a provider benched by a different process.
 */
export function usableProviders(): ProviderConfig[] {
  const now = Date.now();
  const all = availableProviders();
  const ready = all.filter((p) => !isCoolingDown(p.id, now));
  // If everything is cooling down, try anyway rather than failing outright — a stale
  // cooldown must never be the reason a request gets no answer at all.
  return ready.length > 0 ? ready : all;
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
  const {
    tier = 'standard',
    budget,
    temperature = 0.2,
    timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    deadlineMs,
  } = options;
  const deadlineAt = deadlineFrom(deadlineMs);

  // Once per call, before the order is chosen — never once per attempt. A round trip in
  // front of each of five providers would cost more than the benching saves, and this one
  // is usually served from a few-second in-process cache anyway. It cannot throw: with no
  // database, or a failing one, it resolves having changed nothing.
  await loadCooldowns();

  const providers = usableProviders();
  const attempts: Attempt[] = [];

  // Asked once, for the whole call, rather than before every provider attempt.
  //
  // The counter now moves on failures too (see `recordFailedAttempt`), and asking again
  // mid-chain would read that as "the budget is spent" and abandon the remaining
  // providers — turning one slow provider into a failed call, which is precisely what the
  // fallback chain exists to prevent. Callers with a one-call budget (the importer, and
  // now the sync) would have lost their fallback entirely. So the budget answers "may
  // this call start", and what bounds the inside of a call is the deadline above.
  budget?.assertCanSpend();

  // Providers benched by a failure inside THIS call. Kept separate from the global
  // cooldown map on purpose: usableProviders() deliberately hands back everything when
  // every provider is cooling down, and that safety valve must not be re-closed here.
  const benched = new Set<ProviderId>();

  for (const cfg of providers) {
    // Path A — native structured output, but only where it can actually work.
    //
    // `structuredOutput: false` is a measured property of the provider, not a guess (the
    // table in ./models.ts has the numbers). Asking anyway is not a harmless retry: it
    // spends an attempt of the budget, and on Together it spent 5.1 seconds before the
    // SDK reported that the feature is unsupported. Two of the five providers here can
    // never answer this call, and both answer the text path below — so the request that
    // cannot succeed is simply not made.
    if (cfg.structuredOutput) {
      const a = attemptWindow(deadlineAt, timeoutMs);
      if (!a.viable) break;

      try {
        const result = await generateObject({
          model: resolveModel(cfg, tier),
          schema,
          system,
          prompt,
          temperature,
          maxRetries: options.maxRetriesPerProvider ?? 1,
          abortSignal: AbortSignal.timeout(a.ms),
        });
        budget?.record(result.usage?.totalTokens ?? 0);
        return { data: result.object as T, provider: cfg.label };
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        // The prompt went out and was billed before this failed, so it counts.
        budget?.recordFailedAttempt();
        const msg = errText(err);
        if (noteFailure(cfg.id, msg, a.cutShort)) benched.add(cfg.id);
        attempts.push({ provider: cfg.label, error: msg });
      }

      // Path A just benched this provider — it is out of quota, or too slow to be worth
      // the wait. Asking the very same provider again, immediately, cannot succeed, and
      // that doubled cost was a measured part of why extraction overran its budget.
      if (benched.has(cfg.id)) continue;
    }

    const b = attemptWindow(deadlineAt, timeoutMs);
    if (!b.viable) break;

    // Path B — ask for JSON as text, then parse and validate ourselves.
    //
    // Open-weight models behind DeepInfra/Together/Fireworks frequently don't support
    // JSON-schema response formats, or emit JSON wrapped in prose or a code fence.
    // Rather than treat that as "this provider is broken", we take the text and do the
    // structuring on our side. Zod still validates, so nothing malformed gets through —
    // this widens which models work, it does not weaken the contract.
    try {
      const result = await generateText({
        model: resolveModel(cfg, tier),
        system: `${system}\n\nRespond with a single JSON object and nothing else. No prose, no markdown code fence.`,
        prompt: `${prompt}\n\nReturn JSON matching this shape:\n${describeSchema(schema)}`,
        temperature,
        maxRetries: options.maxRetriesPerProvider ?? 1,
        abortSignal: AbortSignal.timeout(b.ms),
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
      budget?.recordFailedAttempt();
      const msg = errText(err);
      if (noteFailure(cfg.id, msg, b.cutShort)) benched.add(cfg.id);
      attempts.push({ provider: `${cfg.label} (json)`, error: msg });
    }
  }

  throw new AllProvidersFailedError(attempts);
}

/**
 * A caller's overall deadline as an absolute instant.
 *
 * Read explicitly rather than truthily: a computed `0` means "no time left", and treating
 * it as "no deadline" would hand the call the unbounded run it was asked not to have.
 */
function deadlineFrom(deadlineMs: number | undefined): number {
  return typeof deadlineMs === 'number' ? Date.now() + Math.max(0, deadlineMs) : Infinity;
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

/**
 * A compact shape hint for models that can't take a real JSON schema.
 *
 * Cached per schema object. Every schema in the app is a module-level constant, so the
 * conversion result can never differ between calls — and it was being recomputed on every
 * text-fallback attempt: convert the whole Zod tree to JSON Schema, stringify it, throw
 * away everything past 4,000 chars. That ran on the path that had already fallen back
 * once, on the cheapest models, in the tightest part of the clock.
 *
 * A WeakMap rather than a Map so a schema built per request (nothing does today) cannot
 * pin its description in memory for the life of the process.
 */
const schemaDescriptions = new WeakMap<z.ZodType<unknown>, string>();

function describeSchema(schema: z.ZodType<unknown>): string {
  const cached = schemaDescriptions.get(schema);
  if (cached !== undefined) return cached;

  let described: string;
  try {
    // Zod 4 ships JSON Schema conversion; keep it terse so it doesn't eat the prompt.
    const json = z.toJSONSchema(schema as z.ZodType);
    described = JSON.stringify(json).slice(0, 4000);
  } catch {
    described = '(object)';
  }

  schemaDescriptions.set(schema, described);
  return described;
}

/** Plain text generation with the same fallback semantics. */
export async function generatePlainText(args: {
  system: string;
  prompt: string;
  options?: CallOptions;
}): Promise<{ text: string; provider: string }> {
  const { system, prompt, options = {} } = args;
  const {
    tier = 'standard',
    budget,
    temperature = 0.3,
    timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    deadlineMs,
  } = options;
  const deadlineAt = deadlineFrom(deadlineMs);

  // Once for the call, not once per provider — same reasoning as generateStructured.
  await loadCooldowns();

  const providers = usableProviders();
  const attempts: Attempt[] = [];

  budget?.assertCanSpend();

  for (const cfg of providers) {
    const a = attemptWindow(deadlineAt, timeoutMs);
    if (!a.viable) break;

    try {
      const result = await generateText({
        model: resolveModel(cfg, tier),
        system,
        prompt,
        temperature,
        maxRetries: options.maxRetriesPerProvider ?? 1,
        abortSignal: AbortSignal.timeout(a.ms),
      });
      budget?.record(result.usage?.totalTokens ?? 0);
      return { text: result.text, provider: cfg.label };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      budget?.recordFailedAttempt();
      const msg = errText(err);
      noteFailure(cfg.id, msg, a.cutShort);
      attempts.push({ provider: cfg.label, error: msg });
    }
  }

  throw new AllProvidersFailedError(attempts);
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}
