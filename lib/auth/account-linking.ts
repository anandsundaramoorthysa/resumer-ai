/**
 * What happens to a password when an OAuth sign-in links to an existing row.
 *
 * This is one `if`, extracted so it can be tested without a database or a request. The
 * rule it encodes is not obvious, and getting it wrong in either direction is serious:
 * too strict and every user who adds a provider loses the password they already proved,
 * too loose and it is an account takeover.
 */

export interface LinkedAccountPatch {
  emailVerified: Date;
  /** Present, and null, only when the password must be discarded. */
  passwordHash?: null;
}

/**
 * Sign-up writes a row for any address that has no row yet, holding the submitted
 * password with `emailVerified` null. That is safe on its own: `authorize()` refuses an
 * unverified row, so the password is inert, and nobody has proved they own the address.
 *
 * It stops being safe the moment something else verifies that row. An attacker signs up
 * as an address they do not own and never opens the mail. The row sits dormant. The real
 * owner later signs in with Google or GitHub, `allowDangerousEmailAccountLinking` matches
 * the row by email — Auth.js does not consult our `emailVerified` when deciding to link —
 * and verifying it here would hand the attacker's password the one gate it was missing.
 * They could then post straight to the credentials endpoint and be signed in as the
 * victim.
 *
 * So: a password on a row that was **not already verified** is discarded. The provider
 * has just proved who owns the inbox; nobody has proved who chose that password. The
 * address keeps working — it signs in with the provider from now on, which is the same
 * state sign-up already puts an OAuth-only address in, and the reset flow already
 * declines to add a password to such an account on purpose.
 *
 * A row that was **already verified** keeps its password. Its owner proved ownership by
 * clicking the link, and someone adding a second way to sign in must not lose the first.
 *
 * @param priorEmailVerified the row's `emailVerified` as it was *before* this sign-in.
 */
export function linkedAccountPatch(
  priorEmailVerified: Date | null | undefined,
  now: Date = new Date(),
): LinkedAccountPatch {
  return priorEmailVerified
    ? { emailVerified: now }
    : { emailVerified: now, passwordHash: null };
}
