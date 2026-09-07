/**
 * Single-use links for email verification and password reset.
 *
 * The token is generated here, emailed in plaintext, and stored only as a SHA-256 hash.
 * A database dump then contains no usable reset link. Consuming one is a conditional
 * update rather than a read-then-write, so two clicks on the same link — which happens
 * constantly, because mail clients prefetch URLs — cannot both succeed.
 */

import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db';
import { authTokens } from '@/lib/db/schema';

export type TokenPurpose = 'verify-email' | 'reset-password';

/** A verification link may sit in an inbox for a while; a reset link should not. */
const LIFETIMES: Record<TokenPurpose, number> = {
  'verify-email': 24 * 60 * 60 * 1000,
  'reset-password': 60 * 60 * 1000,
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueToken(
  identifier: string,
  purpose: TokenPurpose,
): Promise<{ token: string; expires: Date }> {
  // Any outstanding link of the same kind is invalidated first, so a reset requested
  // twice leaves exactly one working link — the newest one the user is looking at.
  await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authTokens.identifier, identifier),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
      ),
    );

  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + LIFETIMES[purpose]);

  await db.insert(authTokens).values({
    identifier,
    purpose,
    tokenHash: hashToken(token),
    expires,
  });

  return { token, expires };
}

export interface ConsumedToken {
  ok: boolean;
  identifier?: string;
  reason?: string;
}

/**
 * Spends a token, returning who it belongs to.
 *
 * The `usedAt is null and expires > now` predicate lives in the UPDATE's WHERE clause on
 * purpose: checking first and writing second lets two concurrent requests both pass the
 * check. Here the database decides, and exactly one update affects a row.
 */
export async function consumeToken(
  token: string,
  purpose: TokenPurpose,
): Promise<ConsumedToken> {
  if (!token || token.length < 16) return { ok: false, reason: 'That link is not valid.' };

  const spent = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
        raw`${authTokens.expires} > now()`,
      ),
    )
    .returning({ identifier: authTokens.identifier });

  if (spent.length === 0) {
    return {
      ok: false,
      reason: 'That link has already been used or has expired. Request a new one.',
    };
  }
  return { ok: true, identifier: spent[0].identifier };
}

/** Housekeeping, called opportunistically — spent and expired rows have no further use. */
export async function purgeExpiredTokens(): Promise<void> {
  await db.delete(authTokens).where(lt(authTokens.expires, new Date(Date.now() - 7 * 86400_000)));
}

/** Constant-time comparison, for callers holding two tokens rather than a hash. */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
