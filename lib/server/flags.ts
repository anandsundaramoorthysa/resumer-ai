/**
 * Kill switches and the maintenance banner: owner-editable rows in `app_setting`.
 *
 *   await getFlag('maintenance_message', '')   // string value
 *   await flagOn('radar_enabled')              // boolean, default true
 *   await assertFlag('ai_enabled')             // throws FlagOffError (user-safe message) when off
 *
 * Resolution order: env FLAG_<KEY> (e.g. FLAG_RADAR_ENABLED=false — works with the DB down),
 * then the table, then the default. One query loads every row, cached 15s per instance with
 * in-flight de-duplication. A DB error FAILS OPEN to the default (a broken settings table must
 * never take the product down) and is retried after 5s.
 *
 * Wired in: `radar_enabled` (lib/radar/handlers.ts), `ai_enabled` (assertDailyBudget in
 * lib/ai/daily-budget.ts) and `signups_enabled` (signUpAction, redeemInvite). See RUNBOOK.md
 * "Kill switches" for how to flip them.
 */

import 'server-only';

export const FLAG_KEYS = ['radar_enabled', 'ai_enabled', 'signups_enabled', 'maintenance_message'] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

export const FLAG_DEFAULTS: Record<FlagKey, string> = {
  radar_enabled: 'true',
  ai_enabled: 'true',
  signups_enabled: 'true',
  maintenance_message: '',
};

const TTL_MS = 15_000;
const RETRY_MS = 5_000;
const OFF = new Set(['false', '0', 'off', 'no', 'disabled']);

export class FlagOffError extends Error {
  constructor(
    readonly key: string,
    message = 'This feature is temporarily switched off. Please try again later.',
  ) {
    super(message);
    this.name = 'FlagOffError';
  }
}

type Loader = () => Promise<Map<string, string>>;

const defaultLoader: Loader = async () => {
  const { db } = await import('@/lib/db');
  const { appSetting } = await import('@/lib/db/schema-ops');
  const rows = await db.select({ key: appSetting.key, value: appSetting.value }).from(appSetting);
  return new Map(rows.map((r) => [r.key, r.value]));
};

let loader: Loader = defaultLoader;
let cache: { at: number; ttl: number; values: Map<string, string> } | null = null;
let inflight: Promise<Map<string, string>> | null = null;

/** Test hook: swap the loader and/or clear the cache. */
export function __resetFlags(next?: Loader): void {
  loader = next ?? defaultLoader;
  cache = null;
  inflight = null;
}

async function values(now = Date.now()): Promise<Map<string, string>> {
  if (cache && now - cache.at < cache.ttl) return cache.values;
  inflight ??= loader()
    .then((v) => {
      cache = { at: Date.now(), ttl: TTL_MS, values: v };
      return v;
    })
    .catch(() => {
      // Fail open: keep serving the last good copy (or nothing -> defaults) and retry shortly.
      cache = { at: Date.now(), ttl: RETRY_MS, values: cache?.values ?? new Map() };
      return cache.values;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const envOverride = (key: string): string | undefined => {
  const v = process.env[`FLAG_${key.toUpperCase()}`];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

export async function getFlag(key: string, def: string): Promise<string> {
  const fromEnv = envOverride(key);
  if (fromEnv !== undefined) return fromEnv;
  const v = (await values()).get(key);
  return v === undefined ? def : v;
}

/** Boolean switch; absent means the key's default (on for every known switch). */
export async function flagOn(key: FlagKey): Promise<boolean> {
  const v = await getFlag(key, FLAG_DEFAULTS[key]);
  return !OFF.has(v.trim().toLowerCase());
}

export async function assertFlag(key: FlagKey, message?: string): Promise<void> {
  if (!(await flagOn(key))) throw new FlagOffError(key, message);
}

export class FlagValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagValueError';
  }
}

export const MAINTENANCE_MESSAGE_MAX = 300;

/** The value to store for `key`, or a FlagValueError written for the owner. */
export function validateFlagValue(key: FlagKey, value: string): string {
  if (typeof value !== 'string') throw new FlagValueError('Value must be text.');
  const clean = value.trim();
  if (key === 'maintenance_message') {
    if (clean.length > MAINTENANCE_MESSAGE_MAX) {
      throw new FlagValueError(`The maintenance message is limited to ${MAINTENANCE_MESSAGE_MAX} characters.`);
    }
    // Plain text only: no markup and no control characters (it is shown to every visitor).
    if (/[<>\u0000-\u0008\u000b-\u001f\u007f]/.test(clean)) {
      throw new FlagValueError('The maintenance message must be plain text (no < > or control characters).');
    }
    return clean;
  }
  if (clean !== 'true' && clean !== 'false') throw new FlagValueError(`${key} must be "true" or "false".`);
  return clean;
}

/** Owner write: upserts the row and records who/what changed in audit_log. */
export async function setFlag(key: FlagKey, value: string, userId: string): Promise<void> {
  const clean = validateFlagValue(key, value);
  const [{ db }, { appSetting }, { auditLog }, { eq }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema-ops'),
    import('@/lib/db/schema'),
    import('drizzle-orm'),
  ]);
  const [prev] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, key));
  await db
    .insert(appSetting)
    .values({ key, value: clean, updatedBy: userId })
    .onConflictDoUpdate({ target: appSetting.key, set: { value: clean, updatedAt: new Date(), updatedBy: userId } });
  await db.insert(auditLog).values({
    userId,
    action: 'flag-set',
    source: 'admin',
    diff: { key, from: prev?.value ?? null, to: clean },
  });
  __resetFlags(loader === defaultLoader ? undefined : loader);
}
