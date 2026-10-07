/**
 * Per-provider circuit breaker, in process memory.
 *
 * Counts consecutive failed provider calls of ANY class (schema failure, 5xx, timeout,
 * retired model). After AI_BREAKER_THRESHOLD (default 3) in a row it opens for
 * AI_BREAKER_OPEN_MS (default 30s): the chain skips the provider, and when every provider
 * is open it fails at once instead of spending the deadline. After the window one probe is
 * let through (half-open); success closes the breaker, failure re-opens it immediately.
 * The chain mirrors an opening into lib/ai/cooldowns.ts, which is what other instances see.
 */

interface State {
  fails: number;
  openUntil: number;
  probeAt: number;
}

// Shared through globalThis: one breaker per process even if the module is loaded twice.
const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for('resumer.breaker')] ??= {
  states: new Map<string, State>(),
  clock: () => Date.now(),
}) as { states: Map<string, State>; clock: () => number };
const states = shared.states;
const clock = () => shared.clock();

const threshold = () => Math.max(1, Number(process.env.AI_BREAKER_THRESHOLD ?? 3) || 3);
const openMs = () => Math.max(1, Number(process.env.AI_BREAKER_OPEN_MS ?? 30_000) || 30_000);

/** Test seam: a fake clock. `undefined` restores Date.now. */
export function setBreakerClock(fn: (() => number) | undefined): void {
  shared.clock = fn ?? (() => Date.now());
}

export function resetBreakers(): void {
  states.clear();
}

/** May this provider be tried now? Consumes the half-open probe slot when it grants one. */
export function breakerAllows(id: string): boolean {
  const s = states.get(id);
  if (!s || s.fails < threshold()) return true;
  const now = clock();
  if (now < s.openUntil) return false;
  // Half-open: one probe per window. An abandoned probe (deadline ran out) frees the slot
  // again after another window rather than wedging the provider shut.
  if (s.probeAt && now - s.probeAt < openMs()) return false;
  s.probeAt = now;
  return true;
}

export function breakerSuccess(id: string): void {
  states.delete(id);
}

/** Returns true when this failure opened (or re-opened) the breaker. */
export function breakerFailure(id: string): boolean {
  const s = states.get(id) ?? { fails: 0, openUntil: 0, probeAt: 0 };
  s.fails += 1;
  states.set(id, s);
  if (s.fails < threshold()) return false;
  s.openUntil = clock() + openMs();
  s.probeAt = 0;
  return true;
}

export function breakerOpen(id: string): boolean {
  const s = states.get(id);
  return !!s && s.fails >= threshold() && clock() < s.openUntil;
}
