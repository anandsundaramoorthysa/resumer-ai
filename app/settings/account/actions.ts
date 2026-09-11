'use server';

import { eq } from 'drizzle-orm';
import { signOut } from '@/auth';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { verifyPassword } from '@/lib/auth/password';

export interface DeleteResult {
  ok: boolean;
  message: string;
}

/**
 * Deletes the account and everything attached to it.
 *
 * Every table references `user.id` with `on delete cascade`, so one statement removes the
 * profile, jobs, resumes, applications, run history, audit log and stored tokens. There
 * was no way for anyone to do this at all — for a product holding contact details, EEO
 * answers, salary expectations and a career history, that is the kind of thing privacy law
 * and ordinary trust both expect to exist.
 *
 * Confirmation is the account's own password where there is one, and typing the email
 * address where the account signs in with Google or GitHub instead.
 */
export async function deleteAccount(confirmation: string): Promise<DeleteResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: 'Sign in first.' };

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, message: 'That account no longer exists.' };

  const given = (confirmation ?? '').trim();
  const confirmed = user.passwordHash
    ? await verifyPassword(given, user.passwordHash)
    : given.toLowerCase() === (user.email ?? '').toLowerCase();
  if (!confirmed) {
    return {
      ok: false,
      message: user.passwordHash ? 'That password is not right.' : 'Type your email address exactly to confirm.',
    };
  }

  await db.delete(users).where(eq(users.id, userId));
  // After the row is gone: the session is a JWT, so it stays valid until it is cleared.
  await signOut({ redirectTo: '/' });
  return { ok: true, message: 'Your account and everything in it have been deleted.' };
}
