import 'server-only';
import { and, count, desc, eq, gte, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { inviteCodes, inviteRedemptions, users } from '@/lib/db/schema';
import { callerIp, rateLimit } from '@/lib/auth/rate-limit';
import { flagOn } from '@/lib/server/flags';
import { autoApproveDailyQuota, signupMode } from './config';
import {
  formatCode,
  generateCode,
  hashCode,
  normalizeCode,
  redeemInvite,
  type RedeemDeps,
  type RedeemStatus,
} from './invite-logic';

/** Postgres-backed store. The advisory lock serialises redemptions so the quota cannot be overshot. */
function pgDeps(userId: string, ip: string | null): RedeemDeps {
  return {
    signupsOpen: () => flagOn('signups_enabled'),
    allow: async () => (await rateLimit('verify', `invite:${userId}`, ip)).allowed,
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('invite-redemption'))`);
        return fn({
          redemptionExists: async (id) =>
            (await tx.select({ id: inviteRedemptions.id }).from(inviteRedemptions).where(eq(inviteRedemptions.userId, id)).limit(1))
              .length > 0,
          redemptionsSince: async (since) =>
            (await tx.select({ n: count() }).from(inviteRedemptions).where(gte(inviteRedemptions.redeemedAt, since)))[0]?.n ?? 0,
          // One conditional UPDATE: the check and the increment cannot be separated.
          claimCode: async (hash, now) => {
            const [row] = await tx
              .update(inviteCodes)
              .set({ uses: sql`${inviteCodes.uses} + 1` })
              .where(
                and(
                  eq(inviteCodes.codeHash, hash),
                  eq(inviteCodes.disabled, false),
                  lt(inviteCodes.uses, inviteCodes.maxUses),
                  or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
                ),
              )
              .returning({ id: inviteCodes.id });
            return row?.id ?? null;
          },
          insertRedemption: async (inviteId, uid, now) => {
            await tx.insert(inviteRedemptions).values({ inviteId, userId: uid, redeemedAt: now });
          },
          approveUser: async (uid, now) =>
            (
              await tx
                .update(users)
                .set({ approval: 'approved', approvalDecidedAt: now })
                .where(and(eq(users.id, uid), eq(users.approval, 'pending')))
                .returning({ id: users.id })
            ).length > 0,
        });
      }),
  };
}

/** Redeems `rawCode` for `userId` (null = SIGNUP_MODE=open, no code). Never throws on user error. */
export async function redeemForUser(userId: string, rawCode: string | null): Promise<RedeemStatus> {
  return redeemInvite(pgDeps(userId, await callerIp()), {
    userId,
    rawCode,
    now: new Date(),
    dailyQuota: autoApproveDailyQuota(),
  });
}

/** Called for a pending account in SIGNUP_MODE=open. A no-op in every other mode. */
export async function autoApproveIfOpen(userId: string): Promise<RedeemStatus | null> {
  return signupMode() === 'open' ? redeemForUser(userId, null) : null;
}

/** Read-only: would this code be accepted right now? Used to reject a typo before an account exists. */
export async function inviteCodeUsable(rawCode: string): Promise<boolean> {
  const norm = normalizeCode(rawCode);
  if (!norm) return false;
  const [row] = await db
    .select({ id: inviteCodes.id })
    .from(inviteCodes)
    .where(
      and(
        eq(inviteCodes.codeHash, hashCode(norm)),
        eq(inviteCodes.disabled, false),
        lt(inviteCodes.uses, inviteCodes.maxUses),
        or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Creates a code and returns the plaintext, which is never stored and cannot be shown again. */
export async function createInvite(input: {
  label: string;
  maxUses: number;
  expiresAt: Date | null;
  createdBy: string;
}): Promise<string> {
  const code = generateCode();
  await db.insert(inviteCodes).values({
    codeHash: hashCode(code),
    label: input.label.slice(0, 80),
    maxUses: Math.min(Math.max(Math.floor(input.maxUses) || 1, 1), 10_000),
    expiresAt: input.expiresAt,
    createdBy: input.createdBy,
  });
  return formatCode(code);
}

export async function listInvites() {
  return db.select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt)).limit(200);
}

export async function setInviteDisabled(id: string, disabled: boolean): Promise<void> {
  await db.update(inviteCodes).set({ disabled }).where(eq(inviteCodes.id, id));
}
