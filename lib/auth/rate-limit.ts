/**
 * Rate limiting for the credential endpoints.
 *
 * Counters live in the database, not in module scope. On a serverless host each request
 * may run in a different instance, and an in-process counter limits only whichever
 * instance happens to answer — which is no limit at all against anyone sending requests
 * in parallel.
 *
 * Limits are per action and applied to two subjects at once: the address being targeted,
 * and the caller's IP. The first stops one account being ground down; the second stops
 * one caller working through a list of addresses.
 */

import 'server-only';
import { headers } from 'next/headers';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { authAttempts } from '@/lib/db/schema';

export type AuthAction = 'sign-in' | 'sign-up' | 'reset-request' | 'verify';

interface Limit {
  max: number;
  windowMs: number;
}

/**
 * Sign-in is the tightest: it is the only action where guessing pays off directly.
 * Sending mail is limited harder per address than per IP, because a stranger triggering
 * reset emails to someone else's inbox is harassment even when they cannot read them.
 */
const LIMITS: Record<AuthAction, { subject: Limit; ip: Limit }> = {
  'sign-in': { subject: { max: 8, windowMs: 15 * 60_000 }, ip: { max: 30, windowMs: 15 * 60_000 } },
  'sign-up': { subject: { max: 3, windowMs: 60 * 60_000 }, ip: { max: 10, windowMs: 60 * 60_000 } },
  'reset-request': { subject: { max: 3, windowMs: 60 * 60_000 }, ip: { max: 10, windowMs: 60 * 60_000 } },
  verify: { subject: { max: 10, windowMs: 60 * 60_000 }, ip: { max: 40, windowMs: 60 * 60_000 } },
};

/**
 * The caller's IP, from the header the platform sets rather than the one the caller can.
 *
 * `x-forwarded-for` is appended to by each hop, so its left-most entry is whatever the
 * client sent — which means reading it first lets an attacker put a fresh fake IP in
 * every request and never land in the same bucket twice. `x-real-ip` is worse: it is a
 * plain client header with no platform guarantee at all.
 *
 * So the platform-set header wins, and `x-forwarded-for` is read from the RIGHT, where
 * the edge appends the address it actually saw. The result must parse as an IP before it
 * is used as a bucket key, or a caller could send two kilobytes of junk per request and
 * fill the attempts table with it.
 */
export async function callerIp(): Promise<string | null> {
  const h = await headers();

  // Netlify's edge sets this from the connection, and it cannot be forged upstream.
  const platform =
    h.get('x-nf-client-connection-ip') ?? h.get('cf-connecting-ip') ?? h.get('x-vercel-forwarded-for');
  if (platform && isIpAddress(platform.trim())) return platform.trim();

  const forwarded = h.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',').map((v) => v.trim());
    const nearest = hops[hops.length - 1];
    if (isIpAddress(nearest)) return nearest;
  }

  // No trustworthy address. The per-address limits still apply; inventing a bucket key
  // from a spoofable header would be worse than admitting there is no IP limit here.
  return null;
}

/** Loose but sufficient: this only decides whether a string may be a bucket key. */
export function isIpAddress(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((o) => Number(o) <= 255);
  }
  return /^[0-9a-f:]+$/i.test(value) && value.includes(':');
}

export interface RateVerdict {
  allowed: boolean;
  /** Deliberately vague — a precise "try again in 412s" is a tool for tuning an attack. */
  message?: string;
}

async function countSince(subject: string, action: AuthAction, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(authAttempts)
    .where(
      and(
        eq(authAttempts.subject, subject),
        eq(authAttempts.action, action),
        gte(authAttempts.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Records the attempt and says whether it may proceed.
 *
 * The attempt is recorded before the verdict, so a request that is about to be refused
 * still counts against the limit. Otherwise a caller who is already over it would stop
 * accumulating and be let back in the moment the window rolled.
 */
export async function rateLimit(
  action: AuthAction,
  subject: string,
  ip: string | null,
  options: { record?: boolean } = {},
): Promise<RateVerdict> {
  const limits = LIMITS[action];
  const now = Date.now();

  // `record: false` reads the counter without adding to it, so a path that is checked
  // twice — the form's friendly pre-check and the authoritative check inside
  // `authorize()` — does not burn two of the user's eight attempts per sign-in.
  if (options.record !== false) {
    const rows = [{ subject: `email:${subject}`, action }];
    if (ip) rows.push({ subject: `ip:${ip}`, action });
    await db.insert(authAttempts).values(rows);
  }

  const subjectCount = await countSince(
    `email:${subject}`,
    action,
    new Date(now - limits.subject.windowMs),
  );
  if (subjectCount > limits.subject.max) {
    return { allowed: false, message: 'Too many attempts. Wait a while and try again.' };
  }

  if (ip) {
    const ipCount = await countSince(`ip:${ip}`, action, new Date(now - limits.ip.windowMs));
    if (ipCount > limits.ip.max) {
      return { allowed: false, message: 'Too many attempts from this connection. Try again later.' };
    }
  }

  return { allowed: true };
}

/**
 * Clears an address's counter after it succeeds, so someone who mistyped their password
 * four times and then got it right is not still near the limit an hour later.
 */
export async function clearAttempts(action: AuthAction, subject: string): Promise<void> {
  await db
    .delete(authAttempts)
    .where(and(eq(authAttempts.subject, `email:${subject}`), eq(authAttempts.action, action)));
}

/** Old rows serve no purpose once every window that could read them has passed. */
export async function purgeOldAttempts(): Promise<void> {
  await db.delete(authAttempts).where(sql`${authAttempts.createdAt} < now() - interval '2 days'`);
}
