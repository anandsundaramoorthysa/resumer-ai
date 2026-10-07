import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { userConsent } from '@/lib/db/schema';
import { POLICY_VERSION, TERMS_VERSION } from './config';

type Writer = Pick<typeof db, 'insert'>;

export async function hasCurrentConsent(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: userConsent.id })
    .from(userConsent)
    .where(and(eq(userConsent.userId, userId), eq(userConsent.policyVersion, POLICY_VERSION)))
    .limit(1);
  return Boolean(row);
}

/** The user's most recent consent row (any version), or null. */
export async function latestConsent(userId: string) {
  const [row] = await db.select().from(userConsent).where(eq(userConsent.userId, userId)).orderBy(desc(userConsent.acceptedAt)).limit(1);
  return row ?? null;
}

/** Idempotent per (user, policy version). Pass a transaction as `tx` to record atomically with sign-up. */
export async function recordConsent(
  userId: string,
  opts: { ageAttested: boolean; source: 'signup' | 'oauth-consent-page' },
  tx: Writer = db,
): Promise<void> {
  if (!opts.ageAttested) throw new Error('Consent requires the age attestation.');
  await tx
    .insert(userConsent)
    .values({ userId, policyVersion: POLICY_VERSION, termsVersion: TERMS_VERSION, ageAttested: true, source: opts.source })
    .onConflictDoNothing();
}
