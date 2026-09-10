/**
 * Whether a signed-in account may set its FIRST password, and on what terms.
 *
 * The gap this closes: signing up with Google or GitHub never writes a `passwordHash`.
 * The row is real, the address is verified, and the account works — but there is nothing
 * for `authorize()` in auth.ts to compare against, so email + password sign-in on that
 * same address fails exactly as a wrong password does. The user is not told why, because
 * telling them apart is the enumeration oracle that failure mode exists to avoid. From
 * the user's side it simply looks like their own account rejecting them.
 *
 * Why this is the place a password gets added, and not the reset flow:
 *
 * `requestPasswordResetAction` deliberately sends nothing to an address with no
 * `passwordHash`, and `signUpAction` deliberately writes nothing for one. Both refuse for
 * the same reason: at that point in the flow nobody has proved they hold the account —
 * only that they know the address — and a "reset" that CREATES a password is a way to
 * take over an OAuth account by typing its owner's email. Loosening either would also
 * contradict lib/auth/account-linking.ts, which discards a password precisely because
 * knowing an address is not owning it.
 *
 * Here that objection does not apply. The caller has just completed an OAuth round trip
 * with the provider, holds a session minted for this exact user row, and is choosing a
 * password for the account they are already inside. That is a stronger proof of ownership
 * than a mailed link, so the password can be established without weakening anything.
 *
 * The rules live here, as pure functions over a row, rather than inline in the server
 * action, for the reason lib/auth/account-linking.ts gives for the same shape: the
 * failure modes are silent. A predicate that answers "yes" for an account that already
 * has a password turns this into an unauthenticated password change for anyone who can
 * link a provider by email; one that answers "yes" for an unverified row re-opens the
 * takeover `linkedAccountPatch` closes. Neither looks like a broken app.
 */

import { checkPassword, type PasswordCheck } from './password-rules';

/** The three columns this decision reads — nothing else about the user matters. */
export interface PasswordAccountState {
  passwordHash: string | null | undefined;
  emailVerified: Date | null | undefined;
  email?: string | null;
}

export type InitialPasswordRefusal = 'already-set' | 'unverified' | 'weak';

export interface InitialPasswordVerdict {
  ok: boolean;
  refusal?: InitialPasswordRefusal;
  message?: string;
  /** Named problems, for the `weak` refusal only — see `checkPassword`. */
  problems?: string[];
}

/**
 * Should this account be offered the "create a password" step at all?
 *
 * Both halves are load-bearing:
 *
 *   - No `passwordHash`. An account that HAS one changes it through the reset flow,
 *     which requires the inbox. Letting this path overwrite an existing password would
 *     mean a linked provider session could replace a password its holder never knew,
 *     which is a password change with no knowledge of the old password.
 *   - `emailVerified` set. Every OAuth sign-in stamps it (see the `signIn` callback in
 *     auth.ts), so for the accounts this exists to serve it is always true. Requiring it
 *     anyway means this can never be the step that lets an unverified row acquire a
 *     working password — which is the exact combination `linkedAccountPatch` refuses.
 */
export function needsInitialPassword(account: PasswordAccountState | null | undefined): boolean {
  if (!account) return false;
  return !account.passwordHash && Boolean(account.emailVerified);
}

/**
 * The full check, run again on the server at the moment of writing.
 *
 * The page decides what to render from `needsInitialPassword`; this decides what to
 * write. They are separate calls against separately-read rows on purpose — the render is
 * a hint and the write is the authority, and a user who opens the form in two tabs, or
 * leaves it open across a sign-out, must not get a second bite at an account that has
 * since acquired a password.
 */
export function initialPasswordVerdict(
  account: PasswordAccountState | null | undefined,
  password: string,
): InitialPasswordVerdict {
  if (!account || account.passwordHash) {
    return {
      ok: false,
      refusal: 'already-set',
      message:
        'This account already has a password. Use "Forgot your password?" on the sign-in page to change it.',
    };
  }

  if (!account.emailVerified) {
    return {
      ok: false,
      refusal: 'unverified',
      message: 'Confirm your email address before setting a password.',
    };
  }

  // Identical rules to sign-up and reset. A password established here is a password that
  // signs in through `authorize()`, so anything weaker than those would be a hole in the
  // fence rather than a convenience.
  const strength: PasswordCheck = checkPassword(password, account.email ?? '');
  if (!strength.ok) {
    return {
      ok: false,
      refusal: 'weak',
      message: 'That password is not strong enough.',
      problems: strength.problems,
    };
  }

  return { ok: true };
}
