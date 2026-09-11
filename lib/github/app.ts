/**
 * GitHub App authentication — installation tokens instead of a stored user token.
 *
 * Why this exists at all:
 *
 * An OAuth App has no read-only scope that reaches private repositories. Asking for
 * `repo` is the only way, and `repo` is read *and write* access to every repository the
 * user owns — for a tool whose whole job is reading one portfolio repo. The consent
 * screen says so in those words, which is both a deterrent and an honest description of
 * a liability: holding that for a hundred users means holding write access to a hundred
 * people's private code.
 *
 * A GitHub App inverts all of it. The user installs it and chooses which repositories,
 * often just the one. The permission is `contents: read`. And the credential is not
 * stored: a token is minted on demand from a private key, lasts an hour, and is scoped
 * to that installation. There is no long-lived repo credential in the database to leak,
 * which is a stronger position than encrypting one.
 *
 * The flow has two steps, and they are genuinely different things:
 *
 *   1. A JWT signed with the app's private key proves "I am this app". It authenticates
 *      the app to GitHub and can do nothing else — it cannot read a repository.
 *   2. That JWT buys an installation token for one installation, which is what actually
 *      reads the repository.
 *
 * Signed with `node:crypto` rather than a JWT library. RS256 is one `createSign` call
 * over two base64url segments, and the alternative is a dependency whose main feature —
 * verifying tokens from someone else — is not something this does.
 */

import 'server-only';
import { createPrivateKey, createSign } from 'node:crypto';

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  /** The URL slug, used to build the install link. */
  slug: string;
}

/**
 * Reads the app credentials.
 *
 * The private key is a multi-line PEM, and environment variables are single-line in most
 * dashboards — so a key pasted with literal `\n` sequences is normalised here rather
 * than failing later with an unhelpful OpenSSL error. Netlify and Vercel both accept
 * real newlines too, and both spellings work.
 */
export function githubAppConfig(): GitHubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !rawKey) return null;

  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  if (!privateKey.includes('BEGIN')) return null;

  return {
    appId,
    privateKey: privateKey.trim(),
    slug: process.env.GITHUB_APP_SLUG?.trim() || '',
  };
}

export function isGitHubAppConfigured(): boolean {
  return githubAppConfig() !== null;
}

/** Where a user goes to install the app and pick their repositories. */
export function installUrl(state?: string): string | null {
  const slug = githubAppConfig()?.slug;
  if (!slug) return null;
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * A short-lived JWT proving this is the app.
 *
 * `iat` is backdated sixty seconds because GitHub rejects a token whose issue time is in
 * their future, and a server clock a few seconds fast is common enough to be worth
 * defending against. Ten minutes is GitHub's maximum lifetime.
 */
export function appJwt(config = githubAppConfig()): string {
  if (!config) throw new Error('GitHub App is not configured.');

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: config.appId }),
  );

  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(createPrivateKey(config.privateKey))
    .toString('base64url');

  return `${header}.${payload}.${signature}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

/**
 * Tokens are cached in module scope for the life of the instance.
 *
 * An installation token is valid for an hour, and minting one is a signed request plus a
 * round trip. The stepped sync makes many short requests in sequence, so without this
 * every step would pay for a new token. Cached with five minutes of headroom, and only
 * in memory — a serverless instance disappearing simply means the next one mints its own.
 */
const tokenCache = new Map<number, InstallationToken>();
const CACHE_HEADROOM_MS = 5 * 60_000;

export async function installationToken(installationId: number): Promise<InstallationToken | null> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt.getTime() - CACHE_HEADROOM_MS > Date.now()) return cached;

  const config = githubAppConfig();
  if (!config) return null;

  try {
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt(config)}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ResumerAI/1.0',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      // 404 here usually means the installation was deleted; 401 means the private key
      // and app id disagree. Both are worth distinguishing in a log.
      console.error(
        `[github-app] could not mint an installation token (HTTP ${res.status}):`,
        (await res.text().catch(() => '')).slice(0, 200),
      );
      tokenCache.delete(installationId);
      return null;
    }

    const body = (await res.json()) as { token: string; expires_at: string };
    const token = { token: body.token, expiresAt: new Date(body.expires_at) };
    tokenCache.set(installationId, token);
    return token;
  } catch (err) {
    console.error(
      '[github-app] token request failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export interface InstallationInfo {
  id: number;
  /** GitHub's numeric id for the account installed on — stable across renames, unlike the login. */
  accountId: number;
  accountLogin: string;
  targetType: string;
  repositorySelection: 'all' | 'selected';
}

/**
 * Whether an installation is on a GitHub account this user has proved is theirs.
 *
 * GitHub confirming an installation exists says nothing about who is asking: the id is a
 * plain integer that turns up in settings URLs and redirects, and the app's JWT can look
 * any of them up. So an installation is accepted only when its account is the GitHub user
 * this person signed in as — `githubAccountIds` are the `providerAccountId`s of their
 * GitHub sign-ins, which GitHub's OAuth vouched for.
 *
 * ponytail: organisation installations are refused. Proving someone administers an org
 * needs `read:org` or a user token from the App's own OAuth client, and neither exists
 * here; add that path when a portfolio in an organisation is actually needed.
 */
export function installationOwnedBy(
  installation: Pick<InstallationInfo, 'accountId' | 'targetType'>,
  githubAccountIds: string[],
): boolean {
  return installation.targetType === 'User' && githubAccountIds.includes(String(installation.accountId));
}

/**
 * Looks up one installation by id, to confirm it exists and who it belongs to.
 *
 * Called after the install callback, because the `installation_id` in that redirect is
 * a URL parameter and therefore something the browser can put anything in. Asking GitHub
 * is what turns it into a fact.
 */
export async function getInstallation(installationId: number): Promise<InstallationInfo | null> {
  const config = githubAppConfig();
  if (!config) return null;

  try {
    const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: {
        Authorization: `Bearer ${appJwt(config)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ResumerAI/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const body = (await res.json()) as {
      id: number;
      account: { id: number; login: string; type: string };
      repository_selection: 'all' | 'selected';
    };

    return {
      id: body.id,
      accountId: body.account?.id ?? 0,
      accountLogin: body.account?.login ?? '',
      targetType: body.account?.type ?? '',
      repositorySelection: body.repository_selection,
    };
  } catch {
    return null;
  }
}

/** The repositories an installation can actually read, for the settings page. */
export async function listInstallationRepos(installationId: number): Promise<string[]> {
  const token = await installationToken(installationId);
  if (!token) return [];

  try {
    const res = await fetch('https://api.github.com/installation/repositories?per_page=100', {
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ResumerAI/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];

    const body = (await res.json()) as { repositories?: Array<{ full_name: string }> };
    return (body.repositories ?? []).map((r) => r.full_name);
  } catch {
    return [];
  }
}

/** Forgets a cached token — used when an installation is removed. */
export function forgetInstallation(installationId: number): void {
  tokenCache.delete(installationId);
}
