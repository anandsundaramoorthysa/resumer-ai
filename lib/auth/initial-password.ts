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
 *
 * Pure, but server-side only: `normalizeEmail` lives in email-policy.ts, which imports
 * `node:dns/promises` at module scope for its MX check, so importing this file from a
 * client component would drag a Node builtin into the browser bundle. A form that wants
 * the strength rules as the user types should import password-rules.ts directly — which
 * is what app/set-password/set-password-form.tsx does, and why it is handed an address
 * that has already been normalised for it rather than normalising one itself.
 */

import { checkPassword, type PasswordCheck } from './password-rules';
import { normalizeEmail } from './email-policy';

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

  /**
   * Identical rules to sign-up and reset. A password established here is a password that
   * signs in through `authorize()`, so anything weaker than those would be a hole in the
   * fence rather than a convenience.
   *
   * The address is normalised on the way in, which is the only part of "identical" that
   * was not free. `checkPassword` uses its second argument for exactly one rule — it
   * takes the local part and refuses a password that contains it — and both other callers
   * hand it an already-normalised value: `signUpAction` passes `verdict.normalized`, and
   * `resetPasswordAction` passes the token's identifier, which was minted from the
   * normalised address. This path is the one that would not have, because the rows it
   * serves are the ones nobody here typed the address for. An OAuth row's `email` is
   * whatever the provider's profile said, so it can still be `First.Last+jobs@gmail.com`
   * where sign-up would have stored `firstlast@gmail.com`.
   *
   * The difference is small and worth stating honestly: it does not gate the write, and
   * it cannot let a bad password through any of the length, repetition or common-list
   * rules. All it changes is how far that one rule reaches — against the raw form the
   * local part is `first.last+jobs`, so `firstlast2026` sails past, and against the
   * normalised form it does not. Being stricter about the guess most obviously tied to
   * this specific account is the right side to err on, and matching what the other two
   * callers already do means the rule cannot be described one way and behave two.
   */
  const strength: PasswordCheck = checkPassword(
    password,
    account.email ? normalizeEmail(account.email) : '',
  );
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
