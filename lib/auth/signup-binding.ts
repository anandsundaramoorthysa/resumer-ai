/**
 * Binding an email-verification link to the browser that signed up.
 *
 * The pre-account-hijack: an attacker signs up with the VICTIM's address and a password
 * the attacker chose. The verification link is mailed to the victim, who clicks it —
 * and that click marks the attacker's password as verified. The attacker now owns an
 * account at the victim's address.
 *
 * The fix is a signed, httpOnly cookie set in the browser that did the signing up. It is
 * an HMAC over (address, password hash), so it is only valid for exactly that pending
 * account, and changes when the password does. At verify time:
 *
 *   - cookie matches  -> the person who typed the password is the person who owns the
 *                        inbox; verify normally.
 *   - cookie missing  -> still verify the address (the mail really was received), but
 *                        the stored password is REPLACED with an unusable random one and
 *                        existing sessions are cut. Nobody who knew the signup password
 *                        can use it; the owner sets their own through "forgot password".
 *                        This also covers a legitimate user who opens the mail on their
 *                        phone: they lose nothing but one reset step.
 *
 * Chosen over "clear the hash always" because the common case (same browser) keeps the
 * smooth flow; and over a stored nonce because this needs no new column.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNUP_BINDING_COOKIE = 'signup_bind';
export const SIGNUP_BINDING_MAX_AGE_SECONDS = 24 * 60 * 60;

export function signupBindingValue(secret: string, email: string, passwordHash: string): string {
  return createHmac('sha256', secret)
    .update(`signup-bind\0${email.trim().toLowerCase()}\0${passwordHash}`)
    .digest('hex');
}

export function signupBindingMatches(
  cookie: string | undefined | null,
  secret: string | undefined | null,
  email: string,
  passwordHash: string | null | undefined,
): boolean {
  if (!cookie || !secret || !passwordHash) return false;
  const expected = Buffer.from(signupBindingValue(secret, email, passwordHash));
  const given = Buffer.from(cookie);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The signing secret Auth.js itself is configured with. */
export function bindingSecret(): string | undefined {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || undefined;
}
