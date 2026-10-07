'use server';

import { eq } from 'drizzle-orm';
import { signOut } from '@/auth';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { aiCall, authAttempts, authTokens, githubInstallations, users } from '@/lib/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { callerIp, rateLimit } from '@/lib/auth/rate-limit';
import { appJwt, githubAppConfig } from '@/lib/github/app';
import { getGithubToken } from '@/lib/server/github-token';

const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'ResumerAI/1.0',
};

/**
 * Revokes the OAuth grant and uninstalls the GitHub App installations. Every failure is
 * swallowed and logged WITHOUT the token, ids of nothing secret, or response bodies.
 */
async function revokeGithubAccess(token: string | null, installationIds: number[]): Promise<void> {
  const clientId = process.env.AUTH_GITHUB_ID;
  const clientSecret = process.env.AUTH_GITHUB_SECRET;
  if (token && clientId && clientSecret) {
    try {
      const res = await fetch(`https://api.github.com/applications/${encodeURIComponent(clientId)}/grant`, {
        method: 'DELETE',
        headers: {
          ...GH_HEADERS,
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok && res.status !== 404) console.warn(`[account] GitHub grant revoke returned ${res.status}`);
    } catch (err) {
      console.warn('[account] GitHub grant revoke failed:', err instanceof Error ? err.name : 'error');
    }
  }

  if (installationIds.length > 0 && githubAppConfig()) {
    for (const id of installationIds) {
      try {
        const res = await fetch(`https://api.github.com/app/installations/${id}`, {
          method: 'DELETE',
          headers: { ...GH_HEADERS, Authorization: `Bearer ${appJwt()}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok && res.status !== 404) {
          console.warn(`[account] installation ${id} uninstall returned ${res.status}`);
        }
      } catch (err) {
        console.warn(`[account] installation ${id} uninstall failed:`, err instanceof Error ? err.name : 'error');
      }
    }
  }
}

export interface DeleteResult {
  ok: boolean;
  message: string;
}

/**
 * Deletes the account and everything attached to it.
 *
 * Every table references `user.id` with `on delete cascade`, so one statement removes the
 * profile, jobs, resumes, applications, run history, audit log and stored tokens. There
 * was no way for anyone to do this at all — for a product holding contact details, EEO
 * answers, salary expectations and a career history, that is the kind of thing privacy law
 * and ordinary trust both expect to exist.
 *
 * Confirmation is the account's own password where there is one, and typing the email
 * address where the account signs in with Google or GitHub instead.
 */
export async function deleteAccount(confirmation: string): Promise<DeleteResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: 'Sign in first.' };

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, message: 'That account no longer exists.' };

  // The typed-email confirmation is guessable by anyone holding a session (the address is
  // not secret), so it is rate limited per account and per connection like a password.
  const limit = await rateLimit('sign-in', `delete-account:${userId}`, await callerIp());
  if (!limit.allowed) return { ok: false, message: limit.message! };

  const given = (confirmation ?? '').trim();
  const confirmed = user.passwordHash
    ? await verifyPassword(given, user.passwordHash)
    : given.toLowerCase() === (user.email ?? '').toLowerCase();
  if (!confirmed) {
    return {
      ok: false,
      message: user.passwordHash ? 'That password is not right.' : 'Type your email address exactly to confirm.',
    };
  }

  // Gathered before the delete: the cascade removes the rows these come from.
  const githubToken = await getGithubToken(userId).catch(() => null);
  const installs = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, userId));

  const email = (user.email ?? '').toLowerCase();
  await db.transaction(async (tx) => {
    // Not tied to the user row by a foreign key, so the cascade would leave them behind:
    // pending reset/verify links and rate-limit counters keyed by the address. The shared
    // IP buckets are left alone — they belong to the connection, not to this account.
    if (email) {
      await tx.delete(authTokens).where(eq(authTokens.identifier, email));
      await tx.delete(authAttempts).where(eq(authAttempts.subject, `email:${email}`));
    }
    await tx.delete(authAttempts).where(eq(authAttempts.subject, `email:delete-account:${userId}`));
    // ai_call.user_id has no foreign key by design (telemetry must never block a deletion),
    // so the cascade does not reach it.
    await tx.delete(aiCall).where(eq(aiCall.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });

  // Best effort, and never a reason to keep the account: the data is already gone.
  await revokeGithubAccess(githubToken, installs.map((i) => i.id));

  // After the row is gone: the session is a JWT, so it stays valid until it is cleared.
  await signOut({ redirectTo: '/' });
  return { ok: true, message: 'Your account and everything in it have been deleted.' };
}
