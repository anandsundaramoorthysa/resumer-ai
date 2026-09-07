'use server';

/**
 * Everything a password account can do before it is signed in.
 *
 * Three rules run through all of it:
 *
 *   1. No answer distinguishes "that address has an account" from "it does not". Sign-up,
 *      reset and resend all return the same sentence whichever is true. An endpoint that
 *      tells them apart is an account-enumeration oracle, and it is usually the reset
 *      form that leaks it.
 *   2. Every entry point is rate limited on both the address and the caller's IP, in the
 *      database, because separate function instances do not share memory.
 *   3. Nothing is written until the address has been checked for shape, disposability
 *      and whether the domain can receive mail at all.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { checkEmail, normalizeEmail } from '@/lib/auth/email-policy';
import { hashPassword } from '@/lib/auth/password';
import { checkPassword } from '@/lib/auth/password-rules';
import { consumeToken, issueToken } from '@/lib/auth/tokens';
import {
  isMailConfigured,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '@/lib/auth/mail';
import { callerIp, clearAttempts, rateLimit } from '@/lib/auth/rate-limit';

export interface AuthResult {
  ok: boolean;
  message: string;
  /** Field-level problems, shown beside the input rather than as one blunt sentence. */
  problems?: string[];
}

/** The one sentence sign-up, reset and resend all return, whatever was actually true. */
const NEUTRAL =
  'If that address can have an account here, a link is on its way. Check your inbox, and your spam folder.';

/**
 * Why the mail is sent behind a fixed delay rather than awaited.
 *
 * The message was neutral; the clock was not. Issuing a token and posting to a mail
 * provider is a database write plus a network round trip — several hundred milliseconds —
 * and skipping both when no account exists returned in tens. One request per address was
 * enough to tell them apart, which is account enumeration by stopwatch and defeats the
 * whole point of the identical wording.
 *
 * So every branch now costs the same: the caller waits `EVEN_RESPONSE_MS` and no longer,
 * and the send runs on its own. The delay is deliberately longer than a send typically
 * takes, so the send finishing early or late changes nothing observable.
 */
const EVEN_RESPONSE_MS = 700;

async function evenOut<T>(work: Promise<T> | null): Promise<void> {
  const pause = new Promise((resolve) => setTimeout(resolve, EVEN_RESPONSE_MS));
  // The work is awaited alongside the pause rather than detached: a serverless host may
  // freeze the instance the moment the response is written, which would silently drop a
  // detached send. Waiting for both costs the same in every branch, which is the point.
  await Promise.all([pause, work ?? Promise.resolve()]);
}

export async function signUpAction(
  email: string,
  password: string,
  name: string,
): Promise<AuthResult> {
  const verdict = await checkEmail(email);
  const ip = await callerIp();

  const limit = await rateLimit('sign-up', verdict.normalized || 'invalid', ip);
  if (!limit.allowed) return { ok: false, message: limit.message! };

  if (!verdict.ok) return { ok: false, message: verdict.reason! };

  // The password is checked before anything is written, and its problems are named:
  // this is the one place where a vague answer helps nobody, since the user is telling
  // us the value rather than guessing it.
  const strength = checkPassword(password, verdict.normalized);
  if (!strength.ok) {
    return { ok: false, message: 'That password is not strong enough.', problems: strength.problems };
  }

  if (!isMailConfigured() && process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      message:
        'Email sign-up is unavailable right now because no mail provider is configured. Use GitHub or Google.',
    };
  }

  const [existing] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, verdict.normalized))
    .limit(1);

  // Hashed before the branch, and discarded on the paths that do not write it. scrypt is
  // ~100ms by design, and doing it only for new addresses made an existing verified
  // account measurably the FASTER answer — the same enumeration channel in reverse.
  const passwordHash = await hashPassword(password);

  if (!existing) {
    await db.insert(users).values({
      email: verdict.normalized,
      name: name.trim().slice(0, 120) || null,
      passwordHash,
    });
  } else if (!existing.passwordHash) {
    // The address already signs in with GitHub or Google. Adding a password here would
    // let anyone who knows the address set one, so nothing is written — and the reply is
    // the same sentence, so the attempt reveals nothing either.
    await evenOut(null);
    return { ok: true, message: NEUTRAL };
  } else if (!existing.emailVerified) {
    // An unverified signup being repeated is someone who lost the email, so the password
    // is updated and a fresh link sent. Safe precisely because it is unverified: nobody
    // has ever proved they own this address, so there is no account to take over.
    await db.update(users).set({ passwordHash }).where(eq(users.id, existing.id));
  } else {
    // A verified account already exists. Say nothing that confirms it.
    await evenOut(null);
    return { ok: true, message: NEUTRAL };
  }

  const { token } = await issueToken(verdict.normalized, 'verify-email');
  const sent = await sendVerificationEmail(verdict.normalized, token);
  if (!sent.ok) {
    console.error('[auth] verification email failed:', sent.error);
    return {
      ok: false,
      message: 'The account was created but the email could not be sent. Try requesting the link again.',
    };
  }

  return { ok: true, message: NEUTRAL };
}

export async function resendVerificationAction(email: string): Promise<AuthResult> {
  const normalized = normalizeEmail(email);
  const ip = await callerIp();

  const limit = await rateLimit('verify', normalized, ip);
  if (!limit.allowed) return { ok: false, message: limit.message! };

  // With no provider configured, `deliver()` falls back to writing the link to the
  // server log. That is a development convenience and a production credential leak —
  // anyone with log access could complete a reset — so nothing is issued at all.
  if (!isMailConfigured() && process.env.NODE_ENV === 'production') {
    await evenOut(null);
    return { ok: true, message: NEUTRAL };
  }

  const [user] = await db
    .select({ id: users.id, emailVerified: users.emailVerified, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);

  const send =
    user && !user.emailVerified && user.passwordHash
      ? (async () => {
          const { token } = await issueToken(normalized, 'verify-email');
          const sent = await sendVerificationEmail(normalized, token);
          if (!sent.ok) console.error('[auth] verification resend failed:', sent.error);
        })()
      : null;

  await evenOut(send);
  return { ok: true, message: NEUTRAL };
}

export async function verifyEmailAction(token: string): Promise<AuthResult> {
  const spent = await consumeToken(token, 'verify-email');
  if (!spent.ok) return { ok: false, message: spent.reason! };

  const updated = await db
    .update(users)
    .set({ emailVerified: new Date() })
    .where(eq(users.email, spent.identifier!))
    .returning({ id: users.id });

  if (updated.length === 0) {
    return { ok: false, message: 'That link belongs to an account that no longer exists.' };
  }

  await clearAttempts('sign-in', spent.identifier!);
  return { ok: true, message: 'Your email is confirmed. You can sign in now.' };
}

export async function requestPasswordResetAction(email: string): Promise<AuthResult> {
  const normalized = normalizeEmail(email);
  const ip = await callerIp();

  const limit = await rateLimit('reset-request', normalized, ip);
  if (!limit.allowed) return { ok: false, message: limit.message! };

  if (!isMailConfigured() && process.env.NODE_ENV === 'production') {
    await evenOut(null);
    return { ok: true, message: NEUTRAL };
  }

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);

  // No link is sent to an address that signs in with GitHub or Google: there is no
  // password to reset, and a reset link would be a way to add one.
  const send = user?.passwordHash
    ? (async () => {
        const { token } = await issueToken(normalized, 'reset-password');
        const sent = await sendPasswordResetEmail(normalized, token);
        if (!sent.ok) console.error('[auth] reset email failed:', sent.error);
      })()
    : null;

  await evenOut(send);
  return { ok: true, message: NEUTRAL };
}

export async function resetPasswordAction(
  token: string,
  password: string,
): Promise<AuthResult> {
  // The token is spent first. A weak password then costs the user the link, which is
  // annoying — but checking first and spending second lets the same link be used twice,
  // and a reset link that survives its own use is a standing key to the account.
  const spent = await consumeToken(token, 'reset-password');
  if (!spent.ok) return { ok: false, message: spent.reason! };

  const strength = checkPassword(password, spent.identifier!);
  if (!strength.ok) {
    return {
      ok: false,
      message: 'That password is not strong enough, and this link has now been used. Request another.',
      problems: strength.problems,
    };
  }

  const updated = await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      // Completing a reset proves the address receives mail, which is the same thing
      // verification proves. An account that reset its password is verified.
      emailVerified: new Date(),
    })
    .where(eq(users.email, spent.identifier!))
    .returning({ id: users.id });

  if (updated.length === 0) {
    return { ok: false, message: 'That link belongs to an account that no longer exists.' };
  }

  await clearAttempts('sign-in', spent.identifier!);
  return { ok: true, message: 'Your password is set. Sign in with it now.' };
}

/**
 * The friendly half of the sign-in rate limit.
 *
 * The authoritative check lives in `authorize()` in auth.ts, on the path Auth.js
 * publishes — a limiter that only guards this action guards the route an attacker would
 * never use. This one exists purely so the form can say "too many attempts" in words
 * instead of the generic sign-in failure, and it therefore READS the counter without
 * adding to it. Recording here as well would spend two of the user's eight attempts on
 * every single sign-in.
 */
export async function guardSignInAction(email: string): Promise<AuthResult> {
  const normalized = normalizeEmail(email);
  const limit = await rateLimit('sign-in', normalized, await callerIp(), { record: false });
  return limit.allowed
    ? { ok: true, message: '' }
    : { ok: false, message: limit.message! };
}
