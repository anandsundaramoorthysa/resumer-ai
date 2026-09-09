/**
 * The one rule that makes a password reset end the sessions that came before it.
 *
 * Sessions here are stateless JWTs — forced rather than chosen, because Auth.js will
 * not issue a database session for the Credentials provider (see the note at the top of
 * auth.ts). There is therefore no session row to delete when someone resets, and the
 * consequence used to be silent: `resetPasswordAction` replaced `passwordHash`, and a
 * token already in an attacker's cookie jar kept working for its full lifetime. The
 * person doing the resetting believed they had just locked the door.
 *
 * So the account records WHEN it last reset, every token records when it was minted,
 * and this compares them. It lives in its own file rather than inline in the `session`
 * callback because that callback cannot be called from a test, and this is the half
 * whose failure is invisible — a comparison with the sign the wrong way round signs
 * either nobody or everybody out, and both look like a working app until the day it
 * matters.
 */

/**
 * @param authAt              when this token was minted, in epoch milliseconds, as the
 *                            `jwt` callback stamped it. Anything that is not a number
 *                            is a token issued before that stamp existed.
 * @param sessionsValidFrom   the account's last password reset, or null if there has
 *                            never been one.
 */
export function sessionSurvivesReset(
  authAt: unknown,
  sessionsValidFrom: Date | null | undefined,
): boolean {
  // Null is "no reset has ever happened on this account", NOT "invalidate everything".
  // The difference is whether shipping this column signs every existing user out.
  if (!sessionsValidFrom) return true;

  // A token from before the stamp existed carries no `authAt`. Treating it as minted at
  // the epoch is the correct reading: it predates the reset, because everything does.
  const mintedAt = typeof authAt === 'number' && Number.isFinite(authAt) ? authAt : 0;

  // Not-before, so a token minted in the same millisecond as the reset survives — that
  // is the user signing in with their new password, not the session being replaced.
  return mintedAt >= sessionsValidFrom.getTime();
}
