'use server';

/**
 * Establishing the first password on an account that arrived through Google or GitHub.
 *
 * Unlike everything in app/sign-in/account-actions.ts, this runs INSIDE a session. That
 * changes what the answers may say: those endpoints all return one neutral sentence
 * because a stranger is asking about an address they may not own, whereas the caller here
 * has already been authenticated as this exact user row. Naming the real problem — "that
 * password is too short", "this account already has one" — leaks nothing they could not
 * read off their own settings page, and a vague answer would just leave them stuck.
 *
 * What it must never become is a password CHANGE. See lib/auth/initial-password.ts for
 * why an account that already has a hash is refused here rather than updated.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { initialPasswordVerdict } from '@/lib/auth/initial-password';
import { clearAttempts } from '@/lib/auth/rate-limit';
import type { AuthResult } from '../sign-in/account-actions';

export async function setInitialPasswordAction(password: string): Promise<AuthResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      ok: false,
      message: 'Your session has expired. Sign in again and we will ask you once more.',
    };
  }

  // Read by id, never by the email in the session. The row is the authority on what this
  // account currently holds, and the JWT is a snapshot that may be a fortnight old.
  const [account] = await db
    .select({
      email: users.email,
      passwordHash: users.passwordHash,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const verdict = initialPasswordVerdict(account, password);
  if (!verdict.ok) {
    return { ok: false, message: verdict.message!, problems: verdict.problems };
  }

  /**
   * `passwordHash` is the only column touched, and the WHERE clause carries the null
   * check a second time.
   *
   * `emailVerified` is deliberately left alone: the provider set it, and rewriting it
   * with a fresh timestamp would claim this moment as the verification when the actual
   * proof happened at the OAuth round trip.
   *
   * `sessionsValidFrom` is deliberately left alone too. It exists to evict sessions that
   * predate a password CHANGE — the attacker a reset is meant to lock out. There is no
   * earlier password here, so there is no session anyone could have obtained with one,
   * and stamping it would sign out the very session that just did this: the `session`
   * callback in auth.ts refuses tokens minted before the stamp, and this user's token was
   * minted moments ago at sign-in.
   *
   * The repeated `isNull` is not belt-and-braces. Two tabs, or a form left open while the
   * account acquired a password some other way, would both pass the check above against
   * rows read before the other write landed; the database is the only place that can
   * settle which one is first, and the loser writing nothing is the correct outcome.
   */
  const updated = await db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(and(eq(users.id, userId), isNull(users.passwordHash)))
    .returning({ id: users.id });

  if (updated.length === 0) {
    return {
      ok: false,
      message:
        'Nothing was changed — this account already has a password, or it no longer exists. Use "Forgot your password?" on the sign-in page.',
    };
  }

  // A stranger may have been guessing this address for the last quarter of an hour, and
  // the counter that stopped them would otherwise lock the owner out of the password they
  // just chose. Sign-up and reset clear it for the same reason.
  if (account.email) await clearAttempts('sign-in', account.email);

  return {
    ok: true,
    message: 'Your password is set. You can now sign in with your email address as well.',
  };
}
