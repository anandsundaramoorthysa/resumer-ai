/**
 * The sign-ups kill switch, as it applies to Google/GitHub sign-in.
 *
 * Password sign-up checks `signups_enabled` itself; OAuth created accounts through the
 * adapter without asking. Auth.js runs the `signIn` callback AFTER the user row exists, so
 * the refusal has to be in the adapter's `createUser` (auth.ts) — existing users never reach
 * it, which is what keeps them able to sign in while sign-ups are paused.
 */

export const SIGNUPS_PAUSED_MESSAGE = 'New sign-ups are paused.';

export class SignupsPausedError extends Error {
  constructor() {
    super(SIGNUPS_PAUSED_MESSAGE);
    this.name = 'SignupsPausedError';
  }
}

/** True when an account may be CREATED through OAuth. */
export function mayCreateOAuthUser(signupsEnabled: boolean): boolean {
  return signupsEnabled;
}

/**
 * What /sign-in?error=… says. A refused createUser surfaces as `Configuration`/`AdapterError`
 * (Auth.js hides adapter errors), so those mean "paused" only while the switch is actually off.
 */
export function signInErrorMessage(code: string | undefined, signupsEnabled: boolean): string | null {
  if (!code) return null;
  if ((code === 'Configuration' || code === 'AdapterError') && !signupsEnabled) return SIGNUPS_PAUSED_MESSAGE;
  if (code === 'AccessDenied') return 'Sign-in was refused. Check that your email is verified with the provider.';
  return 'Sign-in failed. Please try again.';
}
