'use server';

import { eq } from 'drizzle-orm';
import { auth, signOut } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { checkPassword } from '@/lib/auth/password-rules';
import { callerIp, rateLimit } from '@/lib/auth/rate-limit';

export interface SecurityResult {
  ok: boolean;
  message: string;
  problems?: string[];
}

/**
 * Changes the password of a signed-in password account.
 *
 * Needs the current password (a stolen session alone cannot change it) and is rate limited
 * like a sign-in, since the current password is a guess target. Rotating `sessionsValidFrom`
 * ends every session, this one included: the user is sent to sign in with the new password.
 * Re-issuing only this session would need Auth.js's unstable update API; ending all is the
 * safer behaviour and costs one sign-in.
 */
export async function changePasswordAction(current: string, next: string): Promise<SecurityResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: 'Sign in first.' };

  const limit = await rateLimit('sign-in', `change-password:${userId}`, await callerIp());
  if (!limit.allowed) return { ok: false, message: limit.message! };

  const [user] = await db
    .select({ passwordHash: users.passwordHash, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.passwordHash) return { ok: false, message: 'This account has no password yet. Set one first.' };
  if (!(await verifyPassword(current ?? '', user.passwordHash))) return { ok: false, message: 'Your current password is not right.' };

  const strength = checkPassword(next ?? '', user.email ?? '');
  if (!strength.ok) return { ok: false, message: 'That password is not strong enough.', problems: strength.problems };
  if (next === current) return { ok: false, message: 'Pick a password different from the current one.' };

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(next), sessionsValidFrom: new Date() })
    .where(eq(users.id, userId));

  await signOut({ redirectTo: '/sign-in' });
  return { ok: true, message: 'Password changed. Sign in again with the new one.' };
}

/** Ends every session on every device, this one included. */
export async function signOutEverywhereAction(): Promise<SecurityResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: 'Sign in first.' };
  await db.update(users).set({ sessionsValidFrom: new Date() }).where(eq(users.id, userId));
  await signOut({ redirectTo: '/sign-in' });
  return { ok: true, message: 'Signed out everywhere.' };
}
