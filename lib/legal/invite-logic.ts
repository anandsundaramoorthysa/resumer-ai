/**
 * Invite-code rules, free of the database so they can be tested with a stub store.
 *
 * The guarantees live in `redeemInvite`: one transaction, quota checked BEFORE a code is
 * consumed (over quota consumes nothing), the code claimed by a single conditional UPDATE
 * (the real store's `claimCode` is `UPDATE ... WHERE uses < max_uses AND NOT disabled AND
 * not expired RETURNING`), and an account redeems at most once.
 */

import { createHash, randomBytes } from 'node:crypto';
import { istDayStart } from '@/lib/time/ist';

// Crockford base32: no I, L, O, U. 32 symbols, so a random byte maps without bias.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;

export function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  return Array.from(bytes, (b) => ALPHABET[b % 32]).join('');
}

/** XXXX-XXXX-XXXX for reading aloud; normalizeCode accepts it back. */
export function formatCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

/** Upper-cases, drops dashes and spaces, applies Crockford's O/I/L aliases. Null when malformed. */
export function normalizeCode(raw: string): string | null {
  const c = raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(c) ? c : null;
}

export const hashCode = (normalized: string): string => createHash('sha256').update(normalized).digest('hex');

export { istDayStart };

export interface RedeemTx {
  redemptionExists(userId: string): Promise<boolean>;
  redemptionsSince(since: Date): Promise<number>;
  /** Atomically takes one use of the code; the invite id, or null when it is not usable. */
  claimCode(codeHash: string, now: Date): Promise<string | null>;
  insertRedemption(inviteId: string | null, userId: string, now: Date): Promise<void>;
  /** Sets approved only where the account is still pending; false otherwise. */
  approveUser(userId: string, now: Date): Promise<boolean>;
}

export interface RedeemDeps {
  /** Must roll back when the callback throws. */
  transaction<T>(fn: (tx: RedeemTx) => Promise<T>): Promise<T>;
  /** Counts this attempt against the rate limit and says whether it may go ahead. */
  allow(): Promise<boolean>;
  /** Kill switch `signups_enabled`; absent means open. */
  signupsOpen?(): Promise<boolean>;
}

export type RedeemStatus = 'approved' | 'invalid' | 'at-capacity' | 'already' | 'not-pending' | 'rate-limited' | 'paused';

class Rollback extends Error {
  constructor(readonly status: RedeemStatus) {
    super(status);
  }
}

/** rawCode null = SIGNUP_MODE=open: no code, but the same quota and one-per-account rule. */
export async function redeemInvite(
  deps: RedeemDeps,
  input: { userId: string; rawCode: string | null; now: Date; dailyQuota: number },
): Promise<RedeemStatus> {
  if (deps.signupsOpen && !(await deps.signupsOpen())) return 'paused';
  if (!(await deps.allow())) return 'rate-limited';
  let hash: string | null = null;
  if (input.rawCode !== null) {
    const norm = normalizeCode(input.rawCode);
    if (!norm) return 'invalid';
    hash = hashCode(norm);
  }
  try {
    return await deps.transaction(async (tx) => {
      if (await tx.redemptionExists(input.userId)) return 'already';
      if ((await tx.redemptionsSince(istDayStart(input.now))) >= input.dailyQuota) return 'at-capacity';
      const inviteId = hash ? await tx.claimCode(hash, input.now) : null;
      if (hash && !inviteId) return 'invalid';
      await tx.insertRedemption(inviteId, input.userId, input.now);
      if (!(await tx.approveUser(input.userId, input.now))) throw new Rollback('not-pending');
      return 'approved';
    });
  } catch (err) {
    if (err instanceof Rollback) return err.status;
    throw err;
  }
}

export const REDEEM_MESSAGES: Record<RedeemStatus, string> = {
  approved: 'Invite accepted. Your account is approved.',
  invalid: 'That invite code is not valid, has expired, or has been used up.',
  'at-capacity':
    "We're at today's capacity; you're on the list and the owner will approve you. Your code was not used.",
  already: 'This account has already used an invite code.',
  'not-pending': 'This account is not waiting for approval, so a code cannot change it.',
  'rate-limited': 'Too many attempts. Wait a while and try again.',
  paused: 'New sign-ups are paused.',
};
