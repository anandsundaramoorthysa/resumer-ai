/**
 * The only way to read a user's GitHub token — and the only place it is refreshed.
 *
 * Four separate places used to query `accounts.access_token` directly, each with its own
 * copy of the same select. That was survivable while the column held plaintext; with
 * encryption it becomes a trap, because a fifth call site written later would read the
 * ciphertext, hand it to the GitHub API, and fail in a way that looks like an expired
 * token rather than a missing decrypt.
 *
 * Expiry is handled here for the same reason. GitHub OAuth apps can be configured to
 * issue user-to-server tokens that expire in eight hours, with a refresh token good for
 * six months — and this app was configured that way without anything to act on it. The
 * live account's token had expired fourteen hours before this was written, so portfolio
 * sync had been failing silently since, and would have failed again every eight hours
 * forever. A token that refreshes itself is the difference between "connect once" and
 * "reconnect before breakfast".
 */

import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { accounts } from '@/lib/db/schema';
import {
  decryptIfPossible,
  encryptIfPossible,
  isEncryptionConfigured,
  looksEncrypted,
} from '@/lib/auth/secret-box';

/** Refresh a little before the deadline, so a slow request cannot land after it. */
const EXPIRY_SKEW_SECONDS = 120;

interface AccountRow {
  provider: string;
  providerAccountId: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

async function loadGithubAccount(userId: string): Promise<AccountRow | null> {
  const [row] = await db
    .select({
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      accessToken: accounts.access_token,
      refreshToken: accounts.refresh_token,
      expiresAt: accounts.expires_at,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'github')))
    .limit(1);

  return row ?? null;
}

/**
 * The user's GitHub access token in plaintext, refreshed if it has expired, or null.
 *
 * Null covers everything a caller treats alike: no GitHub account linked, no token, a
 * value that could not be decrypted, an expired token with no refresh token, and a
 * refresh that GitHub refused. The last of those is the one worth acting on — it means
 * the grant is gone and the user has to reconnect — and every caller already says so.
 *
 * A row still holding plaintext is re-encrypted as a side effect. That is what migrates
 * the existing data: no backfill to run, no window where sync is broken, and each row
 * upgraded the first time anything reads it.
 */
export async function getGithubToken(userId: string): Promise<string | null> {
  const row = await loadGithubAccount(userId);
  if (!row?.accessToken) return null;

  const accessToken = decryptIfPossible(row.accessToken);
  if (!accessToken) return null;

  if (!isExpired(row.expiresAt)) {
    if (!looksEncrypted(row.accessToken) && isEncryptionConfigured()) {
      await persistTokens(row, {
        access_token: accessToken,
        refresh_token: decryptIfPossible(row.refreshToken) ?? undefined,
        expires_at: row.expiresAt ?? undefined,
      });
    }
    return accessToken;
  }

  const refreshToken = decryptIfPossible(row.refreshToken);
  if (!refreshToken) {
    console.warn('[github-token] token expired and no refresh token is stored.');
    return null;
  }

  const refreshed = await refreshGithubToken(refreshToken);
  if (!refreshed) return null;

  await persistTokens(row, refreshed);
  return refreshed.access_token;
}

function isExpired(expiresAt: number | null): boolean {
  // No expiry recorded means a non-expiring token, which is the older OAuth default.
  if (!expiresAt) return false;
  return expiresAt - EXPIRY_SKEW_SECONDS <= Math.floor(Date.now() / 1000);
}

interface RefreshedTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * GitHub answers with HTTP 200 and an `error` field on failure rather than a 4xx, so the
 * status alone says nothing — a revoked grant looks exactly like a success until the body
 * is read. That is checked explicitly.
 */
async function refreshGithubToken(refreshToken: string): Promise<RefreshedTokens | null> {
  const clientId = process.env.AUTH_GITHUB_ID;
  const clientSecret = process.env.AUTH_GITHUB_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[github-token] cannot refresh: GitHub client credentials are not configured.');
    return null;
  }

  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    } | null;

    if (!body?.access_token || body.error) {
      // The description is logged, never surfaced: it can name the client id.
      console.error(
        '[github-token] refresh refused:',
        body?.error_description ?? body?.error ?? `HTTP ${res.status}`,
      );
      return null;
    }

    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_in
        ? Math.floor(Date.now() / 1000) + body.expires_in
        : undefined,
    };
  } catch (err) {
    console.error(
      '[github-token] refresh failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Writes tokens back, encrypted.
 *
 * Failures are swallowed: this runs on a read path, and a user's sync must not break
 * because the write did. The cost of a lost write is one extra refresh next time —
 * GitHub's refresh tokens are single-use, though, so a lost write does mean the next
 * read has to refresh from a token that has already been spent. That is why the refresh
 * token is persisted in the same statement as the access token rather than separately.
 */
async function persistTokens(row: AccountRow, tokens: RefreshedTokens): Promise<void> {
  try {
    await db
      .update(accounts)
      .set({
        access_token: encryptIfPossible(tokens.access_token),
        // GitHub returns a new refresh token on each use; keeping the old one would
        // leave a spent credential in the row.
        ...(tokens.refresh_token
          ? { refresh_token: encryptIfPossible(tokens.refresh_token) }
          : {}),
        ...(tokens.expires_at ? { expires_at: tokens.expires_at } : {}),
      })
      .where(
        and(
          eq(accounts.provider, row.provider),
          eq(accounts.providerAccountId, row.providerAccountId),
        ),
      );
  } catch (err) {
    console.error(
      '[github-token] could not store refreshed tokens:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** How many stored provider secrets are still in the clear. Used by the health check. */
export async function countPlaintextTokens(): Promise<number> {
  const rows = await db
    .select({ access: accounts.access_token, refresh: accounts.refresh_token })
    .from(accounts);

  return rows.filter(
    (r) =>
      (r.access && !looksEncrypted(r.access)) || (r.refresh && !looksEncrypted(r.refresh)),
  ).length;
}
