'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { sendTemplatedEmail } from '@/lib/auth/mail';
import { inviteRedeemedPendingEmail } from '@/lib/auth/templates';
import { redeemForUser } from '@/lib/legal/invites';
import { REDEEM_MESSAGES } from '@/lib/legal/invite-logic';
import { signupMode } from '@/lib/legal/config';
import { hasCurrentConsent } from '@/lib/legal/consent';

export interface RedeemFormResult {
  ok: boolean;
  message: string;
}

/** The "Have an invite code?" form for accounts that signed in with GitHub or Google. */
export async function redeemInviteAction(code: string): Promise<RedeemFormResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: 'Sign in first.' };
  if (signupMode() !== 'invite') return { ok: false, message: 'Invite codes are not being accepted right now.' };
  if (!(await hasCurrentConsent(userId))) return { ok: false, message: 'Accept the Terms and Privacy Policy first.' };

  const status = await redeemForUser(userId, String(code ?? '').slice(0, 40));
  if (status === 'approved') revalidatePath('/pending');
  if (status === 'at-capacity') {
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (row?.email) await sendTemplatedEmail(row.email, inviteRedeemedPendingEmail()).catch(() => undefined);
  }
  return { ok: status === 'approved', message: REDEEM_MESSAGES[status] };
}
