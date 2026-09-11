/**
 * Who may use the app: every new account waits for the owner's approval.
 *
 * Sign-up stays open, so anyone can create an account, and every account spends the
 * owner's AI keys. The owner chose to see each one and decide. So a new account is
 * `pending` until then: it can sign in, reach the waiting page and delete itself, and
 * nothing else — every page sends it to /pending, and every AI call is refused at the
 * one choke point all of them pass through (lib/ai/daily-budget.ts). A page check alone
 * would be a door with a lock on the front and none on the back.
 *
 * The decision is the owner's alone, and "the owner" is proved, not asserted: a signed-in
 * session whose address is listed in OWNER_EMAILS and verified. The emailed link only
 * opens the review page; it decides nothing, because mail scanners open every link in a
 * message and a GET that approved an account would be approved by a virus scanner.
 */

import 'server-only';
import { redirect } from 'next/navigation';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Session } from 'next-auth';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { ownerEmails, ownerUserIds } from '@/lib/ai/daily-budget';
import { appUrl, sendOperatorEmail } from '@/lib/auth/mail';

export type Approval = 'pending' | 'approved' | 'denied';

/** Whether an account may use the app. Owners always may. */
export async function approvalFor(userId: string): Promise<Approval> {
  if ((await ownerUserIds()).includes(userId)) return 'approved';
  const [row] = await db.select({ approval: users.approval }).from(users).where(eq(users.id, userId)).limit(1);
  const value = row?.approval;
  return value === 'approved' || value === 'denied' ? value : 'pending';
}

/**
 * For every page an approved account uses: the session, or a redirect — to /sign-in when
 * there is none, to /pending when the owner has not approved it.
 */
export async function requireApprovedUser(): Promise<Session & { user: { id: string } }> {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  if ((await approvalFor(session.user.id)) !== 'approved') redirect('/pending');
  return session as Session & { user: { id: string } };
}

/**
 * Whether this session is the owner's: a listed address that has been verified.
 *
 * Verified matters. An address in OWNER_EMAILS that someone registered with a password and
 * never confirmed is not proof of anything — it is a claim, and exactly the one an
 * attacker would make.
 */
export async function isOwnerSession(session: Session | null): Promise<boolean> {
  const userId = session?.user?.id;
  if (!userId) return false;
  const [row] = await db
    .select({ email: users.email, verified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(row?.email && row.verified && ownerEmails().has(row.email.toLowerCase()));
}

export interface PendingAccount {
  id: string;
  email: string | null;
  name: string | null;
  approval: Approval;
  createdAt: Date;
  emailVerified: Date | null;
  decidedAt: Date | null;
}

/** Everyone waiting, then the most recent decisions — for the owner's review page. */
export async function accountsForReview(): Promise<{ pending: PendingAccount[]; decided: PendingAccount[] }> {
  const owners = await ownerUserIds();
  const select = {
    id: users.id,
    email: users.email,
    name: users.name,
    approval: users.approval,
    createdAt: users.createdAt,
    emailVerified: users.emailVerified,
    decidedAt: users.approvalDecidedAt,
  };
  const pending = await db.select(select).from(users).where(eq(users.approval, 'pending')).orderBy(desc(users.createdAt));
  const decided = await db
    .select(select)
    .from(users)
    .where(sql`${users.approval} <> 'pending' and ${users.approvalDecidedAt} is not null`)
    .orderBy(desc(users.approvalDecidedAt))
    .limit(20);
  const notOwner = (a: { id: string }) => !owners.includes(a.id);
  return {
    pending: (pending as PendingAccount[]).filter(notOwner),
    decided: (decided as PendingAccount[]).filter(notOwner),
  };
}

/**
 * Records the owner's decision and tells the person. The caller has already proved the
 * session is the owner's (`isOwnerSession`); this refuses to decide for an owner account.
 */
export async function decide(userId: string, decision: 'approved' | 'denied'): Promise<{ email: string | null } | null> {
  if ((await ownerUserIds()).includes(userId)) return null;
  const [row] = await db
    .update(users)
    .set({ approval: decision, approvalDecidedAt: new Date() })
    .where(and(eq(users.id, userId)))
    .returning({ email: users.email });
  if (!row) return null;

  if (row.email) {
    const sent = await sendOperatorEmail(
      row.email,
      decision === 'approved' ? 'Your Resumer AI account is ready' : 'About your Resumer AI sign-up',
      decision === 'approved'
        ? ['Your account has been approved. Sign in to start building your profile:', '', appUrl('/sign-in')].join('\n')
        : [
            'Thanks for signing up. Access to Resumer AI is limited right now, and your account was not approved.',
            '',
            'Nothing you entered is used for anything. You can delete the account and everything in it here:',
            appUrl('/settings/account'),
          ].join('\n'),
    );
    if (!sent.ok) console.error('[approval] could not email the decision:', sent.error);
  }
  return row;
}
