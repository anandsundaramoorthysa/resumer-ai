/**
 * Where a benched provider is remembered — the store behind lib/ai/chain.ts.
 *
 * WHAT THIS CHANGED, AND WHAT THE OLD BEHAVIOUR COST
 *
 * The cooldown was a module-level `Map<ProviderId, number>`. That is exactly right on a
 * long-lived server and worth nothing on a serverless one: every cold invocation starts
 * with an empty map, so each instance re-learns the same outage at full price. Measured
 * in production this week — Google's `gemini-flash-latest` was overloaded for hours, it
 * is first in the routing order, and EVERY draft paid 4-13 seconds to be told "This model
 * is currently experiencing high demand" before falling through to a provider that
 * answered in about three. The draft budget is 20 seconds, inside a 30-second function
 * limit that kills the request outright. The lesson was learned thousands of times and
 * never once kept.
 *
 * WHAT IT COSTS NOW
 *
 * At most one SELECT per `generateStructured` / `generatePlainText` call, and not even
 * that if another call read within `READ_CACHE_MS`. Never one per attempt: a round trip
 * before each of five providers would spend more than the benching saves. Writes happen
 * only when a provider is actually benched — rare, and they are not awaited, because the
 * caller is on a deadline and a lost write degrades to the in-memory behaviour that
 * existed before this file.
 *
 * WITH NO DATABASE
 *
 * Everything below still works; it just stops crossing process boundaries. Scripts and
 * tests import lib/ai/chain without a DATABASE_URL, and `lib/db` is not even imported in
 * that case — the read resolves to "nothing to add", the write is dropped, and the
 * in-memory map is the whole story. A database that is configured but failing takes the
 * same path: a draft must never fail because a cooldown could not be read.
 */

import type { ProviderId } from './models';

/**
 * @see chain.ts `benchReason` — quota gets the longer cooldown, overload and slow the
 * shorter one, and a failure that says nothing about the provider gets none at all.
 */
export type BenchReason = 'quota' | 'overload' | 'slow';

/**
 * A provider that just told us it is out of quota will still be out of quota a second
 * later, so it stays out for a while.
 */
export const QUOTA_COOLDOWN_MS = Number(process.env.AI_PROVIDER_COOLDOWN_MS ?? 120_000);

/**
 * Shorter, for a provider that was merely overloaded or slow. Overload is "usually
 * temporary" in the provider's own words, and one timeout is enough evidence to stop
 * asking without being enough to write the provider off for two minutes.
 */
export const SLOW_COOLDOWN_MS = Number(process.env.AI_SLOW_COOLDOWN_MS ?? 60_000);

/**
 * How long a read is reused before another one is allowed.
 *
 * Small on purpose. It only has to collapse the several chain calls a single draft makes
 * into one query; anything longer starts hiding a provider that has come back, and the
 * cooldowns themselves are measured in minutes, so precision here buys nothing.
 */
export const READ_CACHE_MS = Number(process.env.AI_COOLDOWN_CACHE_MS ?? 5_000);

export function cooldownMsFor(reason: BenchReason): number {
  return reason === 'quota' ? QUOTA_COOLDOWN_MS : SLOW_COOLDOWN_MS;
}

export interface Cooldown {
  /** Epoch milliseconds. */
  until: number;
  reason: BenchReason;
}

export type CooldownEntry = Cooldown & { providerId: ProviderId };

/* ------------------------------------------------------------------ pure ---- */

/**
 * Whether a fresh read is due. Pure so the caching decision can be pinned by a test
 * rather than by waiting five seconds in one.
 *
 * `lastReadAt` of 0 means "never read", which is always due — including the case where
 * `now` is small, so this is a subtraction rather than a comparison against a stored
 * expiry.
 */
export function shouldRead(lastReadAt: number, now: number, ttlMs = READ_CACHE_MS): boolean {
  return lastReadAt === 0 || now - lastReadAt >= ttlMs;
}

/**
 * Fold what the database knows into what this process knows.
 *
 * Two rules, both load-bearing:
 *
 *  - Expired entries are dropped, on both sides. A row outlives its cooldown (nothing
 *    deletes it), so a stale row must never bench anyone.
 *  - Where both sides have a provider, the LATER instant wins. The local entry is
 *    usually newer than a read taken up to `READ_CACHE_MS` ago — we may have just
 *    benched the provider ourselves — and taking the earlier one would un-bench a
 *    provider we watched fail a moment ago.
 *
 * Returns a new map; the caller decides whether to install it.
 */
export function mergeCooldowns(
  local: ReadonlyMap<ProviderId, Cooldown>,
  incoming: readonly CooldownEntry[],
  now: number,
): Map<ProviderId, Cooldown> {
  const merged = new Map<ProviderId, Cooldown>();

  for (const [id, cooldown] of local) {
    if (cooldown.until > now) merged.set(id, cooldown);
  }
  for (const { providerId, ...cooldown } of incoming) {
    if (cooldown.until <= now) continue;
    const existing = merged.get(providerId);
    if (!existing || cooldown.until > existing.until) merged.set(providerId, cooldown);
  }

  return merged;
}

/* --------------------------------------------------------------- storage ---- */

/**
 * The persistence seam. Real implementation is Drizzle; tests substitute a fake, and a
 * process with no database gets `null` and never calls either method.
 */
export interface CooldownBackend {
  /** Entries that have not expired as of `now`. Must resolve, never reject. */
  read(now: number): Promise<CooldownEntry[]>;
  /** Record one bench. Must resolve, never reject. */
  write(entry: CooldownEntry): Promise<void>;
}

const cooldowns = new Map<ProviderId, Cooldown>();
/** Writes in flight. Nothing on a request path waits on these — see flushCooldownWrites. */
const pendingWrites = new Set<Promise<void>>();
let lastReadAt = 0;
/** In-flight read, so concurrent calls in one instance share a single query. */
let reading: Promise<void> | null = null;
/** `undefined` = not resolved yet, `null` = resolved to "no database". */
let backend: CooldownBackend | null | undefined;
let backendResolving: Promise<CooldownBackend | null> | null = null;

/**
 * The Drizzle-backed store, or null when there is no usable database.
 *
 * `lib/db` is imported lazily and only when DATABASE_URL looks present, because
 * importing it constructs a postgres client — harmless, but tests and scripts that use
 * the chain without a database should not be made to carry one. `isDatabaseConfigured`
 * is still the authority on whether the URL is actually usable; the env check here only
 * decides whether it is worth asking.
 */
async function resolveBackend(): Promise<CooldownBackend | null> {
  if (backend !== undefined) return backend;
  backendResolving ??= (async () => {
    try {
      if (!process.env.DATABASE_URL?.trim()) return null;

      const [{ db, isDatabaseConfigured }, { aiProviderCooldown }, { gt, sql }] =
        await Promise.all([
          import('@/lib/db'),
          import('@/lib/db/schema'),
          import('drizzle-orm'),
        ]);
      if (!isDatabaseConfigured) return null;

      return {
        async read(now: number): Promise<CooldownEntry[]> {
          try {
            const rows = await db
              .select({
                providerId: aiProviderCooldown.providerId,
                until: aiProviderCooldown.until,
                reason: aiProviderCooldown.reason,
              })
              .from(aiProviderCooldown)
              // Filtered in SQL rather than in JS: the expired rows are the majority
              // once an outage passes, and nothing prunes them.
              .where(gt(aiProviderCooldown.until, new Date(now)));

            return rows.map((r) => ({
              providerId: r.providerId as ProviderId,
              until: r.until.getTime(),
              reason: r.reason as BenchReason,
            }));
          } catch (err) {
            console.warn('[cooldown] could not read provider cooldowns:', errText(err));
            return [];
          }
        },

        async write(entry: CooldownEntry): Promise<void> {
          try {
            await db
              .insert(aiProviderCooldown)
              .values({
                providerId: entry.providerId,
                until: new Date(entry.until),
                reason: entry.reason,
              })
              .onConflictDoUpdate({
                target: aiProviderCooldown.providerId,
                // Last writer wins, exactly as the old Map did on a repeated failure.
                // A quota bench landing on top of a slow one shortens nothing that
                // matters: the provider just failed again, so the fresh verdict is the
                // better one.
                set: {
                  until: new Date(entry.until),
                  reason: entry.reason,
                  updatedAt: sql`now()`,
                },
              });
          } catch (err) {
            console.warn('[cooldown] could not persist a provider cooldown:', errText(err));
          }
        },
      } satisfies CooldownBackend;
    } catch (err) {
      // A schema mismatch, a module that will not load, anything at all. The chain keeps
      // working from memory; it must never be the reason a draft fails.
      console.warn('[cooldown] persistence unavailable, using in-memory only:', errText(err));
      return null;
    }
  })();

  backend = await backendResolving;
  backendResolving = null;
  return backend;
}

/**
 * Bring this process up to date — called ONCE per chain call, before the provider order
 * is chosen, and a no-op when a read happened within `READ_CACHE_MS`.
 */
export async function loadCooldowns(now = Date.now()): Promise<void> {
  if (!shouldRead(lastReadAt, now)) return;
  if (reading) return reading;

  // Stamped before the await, not after: a second caller arriving mid-query must not
  // start its own, and if this read fails we still want the TTL to hold off the next
  // attempt rather than querying a broken database on every call.
  lastReadAt = now;

  reading = (async () => {
    try {
      const store = await resolveBackend();
      if (!store) return;
      const entries = await store.read(now);
      installMerged(entries, Date.now());
    } catch (err) {
      // The Drizzle backend already swallows its own failures; this catches a backend
      // that does not, so the contract callers rely on — "this cannot throw" — holds
      // whatever is installed. A draft must not fail because a cooldown could not be read.
      console.warn('[cooldown] read failed, continuing from memory:', errText(err));
    }
  })().finally(() => {
    reading = null;
  });

  return reading;
}

function installMerged(entries: readonly CooldownEntry[], now: number): void {
  const merged = mergeCooldowns(cooldowns, entries, now);
  cooldowns.clear();
  for (const [id, cooldown] of merged) cooldowns.set(id, cooldown);
}

/**
 * Bench a provider, here and everywhere.
 *
 * The in-memory map is updated synchronously, so the call that just watched the provider
 * fail skips it immediately — that part cannot depend on a database. The write is fired
 * and not awaited: the caller is inside a deadline, the value of the write is entirely to
 * OTHER instances, and its failure mode is the behaviour this file replaced.
 *
 * Returns the instant the provider is benched until.
 */
export function noteBench(providerId: ProviderId, reason: BenchReason, now = Date.now()): number {
  const until = now + cooldownMsFor(reason);
  cooldowns.set(providerId, { until, reason });

  const write = resolveBackend()
    .then((store) => store?.write({ providerId, until, reason }))
    .catch((err) => {
      // Caught rather than left floating: an unhandled rejection here would take down a
      // Node process over a cooldown row nobody is waiting for.
      console.warn('[cooldown] write failed, this bench stays local:', errText(err));
    })
    .finally(() => {
      pendingWrites.delete(write);
    });
  pendingWrites.add(write);

  return until;
}

/**
 * Wait for the fire-and-forget writes to land.
 *
 * Nothing on a request path calls this, deliberately — the caller is on a deadline and
 * the value of the write is entirely to other instances. It exists for a script that
 * needs to observe the row it just caused, and for a long-lived process shutting down.
 */
export async function flushCooldownWrites(): Promise<void> {
  await Promise.all([...pendingWrites]);
}

/** True when this provider is currently benched. Synchronous — reads only memory. */
export function isCoolingDown(providerId: ProviderId, now = Date.now()): boolean {
  return (cooldowns.get(providerId)?.until ?? 0) > now;
}

/** What this process currently believes, for scripts and diagnostics. */
export function cooldownSnapshot(now = Date.now()): CooldownEntry[] {
  return [...cooldowns]
    .filter(([, c]) => c.until > now)
    .map(([providerId, c]) => ({ providerId, ...c }));
}

/**
 * Test seam. Installing a fake backend also clears the cache, so a suite never inherits
 * the previous one's state.
 */
export function setCooldownBackend(fake: CooldownBackend | null): void {
  backend = fake;
  backendResolving = null;
  resetCooldownCache();
}

/** Forgets everything read so far, without touching which backend is installed. */
export function resetCooldownCache(): void {
  cooldowns.clear();
  lastReadAt = 0;
  reading = null;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}
