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

import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import {
  SIGNUP_BINDING_COOKIE,
  SIGNUP_BINDING_MAX_AGE_SECONDS,
  bindingSecret,
  signupBindingMatches,
  signupBindingValue,
} from '@/lib/auth/signup-binding';
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
import { notifyOwnerOfSignup } from '@/lib/server/signup-notice';
import { recordConsent } from '@/lib/legal/consent';
import { signupMode } from '@/lib/legal/config';
import { inviteCodeUsable, redeemForUser } from '@/lib/legal/invites';
import { REDEEM_MESSAGES } from '@/lib/legal/invite-logic';

/** Holds a password signup's invite code until its email is verified (see signUpAction). */
const SIGNUP_INVITE_COOKIE = 'signup_invite';
import { flagOn } from '@/lib/server/flags';

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
  consent: { accepted: boolean; inviteCode?: string } = { accepted: false },
): Promise<AuthResult> {
  const verdict = await checkEmail(email);
  const ip = await callerIp();

  const limit = await rateLimit('sign-up', verdict.normalized || 'invalid', ip);
  if (!limit.allowed) return { ok: false, message: limit.message! };

  if (!verdict.ok) return { ok: false, message: verdict.reason! };

  // Kill switch: nothing is written while sign-ups are paused.
  if (!(await flagOn('signups_enabled'))) return { ok: false, message: REDEEM_MESSAGES.paused };

  // Enforced here, not just by the form's required checkbox: a server action is an endpoint.
  if (consent.accepted !== true) {
    return { ok: false, message: 'Confirm that you are 18 or older and agree to the Terms and Privacy Policy.' };
  }
  // Codes only count in 'invite' mode. A mistyped code is refused before anything is written
  // (the answer does not depend on whether the address has an account).
  const inviteCode = signupMode() === 'invite' ? (consent.inviteCode ?? '').trim().slice(0, 40) : '';
  if (inviteCode && !(await inviteCodeUsable(inviteCode))) {
    return { ok: false, message: REDEEM_MESSAGES.invalid };
  }

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

  let accountId: string | null = null;
  if (!existing) {
    // The account and the consent record are written together: there is never an
    // account created through this form without a record of what it agreed to.
    accountId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ email: verdict.normalized, name: name.trim().slice(0, 120) || null, passwordHash })
        .returning({ id: users.id });
      await recordConsent(created.id, { ageAttested: true, source: 'signup' }, tx);
      return created.id;
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
    accountId = existing.id;
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, existing.id));
      await recordConsent(existing.id, { ageAttested: true, source: 'signup' }, tx);
    });
  } else {
    // A verified account already exists. Say nothing that confirms it.
    await evenOut(null);
    return { ok: true, message: NEUTRAL };
  }

  // An invite code is NOT redeemed here. A password signup has proved nothing about its
  // address yet, so redeeming now would let anyone burn codes and the daily auto-approve
  // quota with throwaway addresses. The code rides in an httpOnly cookie of this browser and
  // is redeemed by verifyEmailAction once the address is confirmed (OAuth accounts, whose
  // address is already verified, redeem on /pending). If the link is opened in another
  // browser the cookie is absent and the person enters the code on /pending instead.
  if (inviteCode && accountId) {
    (await cookies()).set(SIGNUP_INVITE_COOKIE, inviteCode, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SIGNUP_BINDING_MAX_AGE_SECONDS,
    });
  }

  // Bind the emailed link to THIS browser (see lib/auth/signup-binding.ts): the victim of a
  // signup made with their address will not hold this cookie.
  const secret = bindingSecret();
  if (secret) {
    (await cookies()).set(
      SIGNUP_BINDING_COOKIE,
      signupBindingValue(secret, verdict.normalized, passwordHash),
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: SIGNUP_BINDING_MAX_AGE_SECONDS,
      },
    );
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

  // Pre-account-hijack defence: unless this browser is the one that signed up, the address
  // is confirmed but the signup password is replaced with an unusable one and old sessions
  // are cut. The owner of the inbox sets their own password via "forgot password".
  const jar = await cookies();
  const [pending] = await db
    .select({ passwordHash: users.passwordHash, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, spent.identifier!))
    .limit(1);
  const bound =
    !pending?.passwordHash ||
    Boolean(pending.emailVerified) ||
    signupBindingMatches(
      jar.get(SIGNUP_BINDING_COOKIE)?.value,
      bindingSecret(),
      spent.identifier!,
      pending.passwordHash,
    );
  const pendingInvite = jar.get(SIGNUP_INVITE_COOKIE)?.value ?? '';
  const patch: Partial<typeof users.$inferInsert> = { emailVerified: new Date() };
  if (!bound) {
    patch.passwordHash = await hashPassword(randomBytes(32).toString('hex'));
    patch.sessionsValidFrom = new Date();
  }
  try {
    jar.delete(SIGNUP_BINDING_COOKIE); // throws when called during a page render; harmless
    jar.delete(SIGNUP_INVITE_COOKIE);
  } catch {
    /* the cookie expires on its own */
  }

  const updated = await db
    .update(users)
    .set(patch)
    .where(eq(users.email, spent.identifier!))
    .returning({ id: users.id, email: users.email, name: users.name, approval: users.approval });

  if (updated.length === 0) {
    return { ok: false, message: 'That link belongs to an account that no longer exists.' };
  }

  await clearAttempts('sign-in', spent.identifier!);

  if (!bound) {
    return {
      ok: true,
      message:
        'Your email is confirmed. For your security, set your password with "Forgot password" before signing in.',
    };
  }

  // A password sign-up reaches the owner only once its address is proved: before that it
  // could be anyone typing anything, and a bot that never confirms never becomes mail.
  if (updated[0].approval === 'pending') {
    // The address is proved (emailVerified was written above), so the invite from sign-up
    // may now be redeemed. Never throws; anything but 'approved' leaves the owner to decide.
    if (pendingInvite && signupMode() === 'invite') {
      const status = await redeemForUser(updated[0].id, pendingInvite).catch((err) => {
        console.error('[auth] invite redemption failed:', err instanceof Error ? err.name : 'error');
        return null;
      });
      if (status === 'approved') return { ok: true, message: 'Your email is confirmed and your invite was accepted. You can sign in now.' };
    }
    await notifyOwnerOfSignup(updated[0], 'Email and password');
    return {
      ok: true,
      message:
        'Your email is confirmed. The site owner approves new accounts, and you will get an email as soon as yours is ready.',
    };
  }
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
      // And every session that existed before this moment stops working — see the
      // `session` callback in auth.ts. Changing the password alone would not have done
      // it: sessions here are stateless JWTs with nothing to delete, so anyone already
      // signed in stayed signed in, including the person the reset was meant to evict.
      sessionsValidFrom: new Date(),
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
