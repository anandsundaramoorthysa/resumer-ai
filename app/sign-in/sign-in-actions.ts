'use server';

import { AuthError } from 'next-auth';
import { signIn } from '@/auth';
import { normalizeEmail } from '@/lib/auth/email-policy';
import { guardSignInAction, type AuthResult } from './account-actions';

/**
 * Password sign-in.
 *
 * On success `signIn` throws a redirect, which must be allowed to escape — catching
 * everything here would swallow it and leave the user on the form, signed in, with no
 * indication anything happened. Only `AuthError` is handled.
 *
 * Every failure returns one sentence. Wrong password, no such account, and an address
 * that has not confirmed its email are three different facts, and telling them apart is
 * how a stranger works out which addresses have accounts. The unconfirmed case is named
 * as a possibility in the message rather than as a diagnosis of this attempt.
 */
export async function passwordSignInAction(
  email: string,
  password: string,
): Promise<AuthResult> {
  const guard = await guardSignInAction(email);
  if (!guard.ok) return guard;

  try {
    await signIn('credentials', {
      email: normalizeEmail(email),
      password,
      redirectTo: '/',
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        ok: false,
        message:
          'That email and password do not match an account — or the address has not been confirmed yet.',
      };
    }
    throw err;
  }

  // Unreachable in practice: a successful `signIn` throws a redirect above. The counter
  // is cleared inside `authorize()`, which is the only place that can see a success.
  return { ok: true, message: 'Signed in.' };
}

/**
 * Provider sign-in, which lands on the password step rather than the dashboard.
 *
 * Not because every provider user needs one — /set-password redirects straight to `/`
 * for any account that already has a password, so this is a no-op for everyone except
 * the accounts it exists for. The redirect target is decided here rather than after the
 * fact because the answer is not known yet: whether a row exists, and whether it holds a
 * password, is only settled inside the OAuth callback, and `signIn` takes its
 * `redirectTo` before any of that has happened.
 *
 * Signing up with Google or GitHub writes no `passwordHash`, so email + password sign-in
 * on that same address fails — indistinguishably from a wrong password, by design. This
 * is where that account is offered the missing half. See app/set-password/page.tsx for
 * why it is a step on the way in and not a gate on every route.
 */
export async function oauthSignInAction(provider: 'github' | 'google'): Promise<void> {
  await signIn(provider, { redirectTo: '/set-password' });
}
