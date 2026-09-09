/**
 * How the sync gets permission to read a portfolio repository.
 *
 * Two ways, in order of preference:
 *
 *   1. A **GitHub App installation token**. Minted on demand from the app's private key,
 *      valid for an hour, scoped `contents: read` on only the repositories the user
 *      chose. Nothing long-lived is stored, so there is no repo credential in the
 *      database to leak — a better position than encrypting one.
 *
 *   2. The user's **OAuth token**, which is how this worked before. Kept because it is
 *      what every existing user has: flipping to the App without a fallback would break
 *      sync for everyone until they each went and installed it. It is the fallback, not
 *      the default, and it disappears from a user's account the moment they install.
 *
 * Callers ask for access to a specific repository rather than for "the user's token",
 * because with installations that is the honest question — permission is per-repository
 * now, and a token that can read one repo cannot necessarily read another.
 */

import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { githubInstallations } from '@/lib/db/schema';
import {
  installationToken,
  isGitHubAppConfigured,
  listInstallationRepos,
} from '@/lib/github/app';
import { getGithubToken } from './github-token';

export type RepoAccessSource = 'installation' | 'oauth';

export interface RepoAccess {
  token: string;
  source: RepoAccessSource;
  /** Set for an installation, so callers can report which one was used. */
  installationId?: number;
}

/** Every live installation belonging to this user. */
export async function installationsFor(userId: string) {
  return db
    .select()
    .from(githubInstallations)
    .where(
      and(eq(githubInstallations.userId, userId), isNull(githubInstallations.removedAt)),
    );
}

/**
 * A token that can read `owner/name`, or null.
 *
 * The installation is chosen by owner rather than by asking GitHub which installation
 * covers the repo: one extra API call per sync step to learn something the owner name
 * already tells us, and the sync is stepped precisely because it has no time to spare.
 * A mismatch simply falls through to the next candidate.
 */
export async function getRepoAccess(
  userId: string,
  repo: { owner: string; name: string },
): Promise<RepoAccess | null> {
  if (isGitHubAppConfigured()) {
    const installations = await installationsFor(userId);

    const byOwner = installations.filter(
      (i) => i.accountLogin.toLowerCase() === repo.owner.toLowerCase(),
    );
    // An installation on a different account can still be tried afterwards: a fork or a
    // transferred repository leaves the owner name and the installation disagreeing.
    for (const installation of [...byOwner, ...installations.filter((i) => !byOwner.includes(i))]) {
      const token = await installationToken(installation.id);
      if (token) {
        return { token: token.token, source: 'installation', installationId: installation.id };
      }
    }
  }

  const oauth = await getGithubToken(userId);
  return oauth ? { token: oauth, source: 'oauth' } : null;
}

/**
 * Whether an installation can actually see the repository the user named.
 *
 * Worth checking explicitly at connect time: the commonest mistake is installing the app
 * and selecting the wrong repository, which otherwise surfaces much later as a 404 from
 * the sync that reads like the repo does not exist.
 */
export async function installationCoversRepo(
  installationId: number,
  fullName: string,
): Promise<boolean> {
  const repos = await listInstallationRepos(installationId);
  if (repos.length === 0) return false;
  return repos.some((r) => r.toLowerCase() === fullName.toLowerCase());
}

/* ------------------------------------------------- who may connect a repo ---- */

/** The `permissions` block GitHub returns on `GET /repos/{owner}/{repo}`. */
export interface RepoPermissions {
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
  pull?: boolean;
}

/**
 * Whether a repository is the caller's to sync, judged by what they can do to it.
 *
 * Read access is not the question, which is the mistake this replaces. `connectRepo`
 * used to accept any repository the user's token could read — and an OAuth token can
 * read every public repository on GitHub, so "connect your portfolio" accepted a
 * stranger's repo, whose files an LLM then parsed into the user's profile.
 *
 * Write access is the right line for two reasons. It is the property that makes the
 * content the user's responsibility: someone who can push to a repository can already
 * put anything they like in it, so requiring write adds no capability an attacker
 * lacks, while read-only access to a repository is something the whole internet has.
 * And it keeps the legitimate organisation case working — a portfolio living in an org
 * the user belongs to is connectable as long as they are a member with push rights,
 * which is exactly the set of people who maintain it. A member with read-only access to
 * an org repository is told to install the GitHub App instead, which is an explicit
 * grant by someone who administers that account rather than a default of membership.
 *
 * `maintain` counts: GitHub's maintain role includes push. `triage` and `pull` do not.
 *
 * What this does NOT stop, and is not meant to: a user forking a hostile "portfolio
 * template" into their own account and connecting that. The fork is genuinely theirs by
 * every measure GitHub has. That vector is the review queue's job — see
 * lib/sync/reconcile.ts — and this check is the cheap half that removes the rest.
 */
export function canConnectWithPermissions(perms: RepoPermissions | undefined): boolean {
  if (!perms) return false;
  return Boolean(perms.admin || perms.maintain || perms.push);
}

export type ConnectVerdict =
  | { ok: true; via: 'installation' | 'write-access' }
  | { ok: false; code: 'no-access' | 'read-only' | 'not-found' | 'error'; message: string };

/**
 * Decides whether this user may connect `owner/name` as their portfolio.
 *
 * Installations are checked first and exhaustively rather than via `getRepoAccess`,
 * which picks one candidate by owner name and stops. That shortcut is right during a
 * sync, where the cost of an extra API call is measured against a step budget; here it
 * would refuse a repository the user really does have an installation on, and connect
 * happens once.
 */
export async function canConnectRepo(
  userId: string,
  repo: { owner: string; name: string },
): Promise<ConnectVerdict> {
  const fullName = `${repo.owner}/${repo.name}`;

  if (isGitHubAppConfigured()) {
    for (const installation of await installationsFor(userId)) {
      if (await installationCoversRepo(installation.id, fullName)) {
        return { ok: true, via: 'installation' };
      }
    }
  }

  const token = await getGithubToken(userId);
  if (!token) {
    return {
      ok: false,
      code: 'no-access',
      message: isGitHubAppConfigured()
        ? `No access to ${fullName}. Install the GitHub App on it below, or sign in with GitHub.`
        : `No GitHub token on your account. Sign out and sign in again to grant repo access.`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
    });
  } catch (err) {
    return {
      ok: false,
      code: 'error',
      message: `Couldn't reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status === 404) {
    return {
      ok: false,
      code: 'not-found',
      message: `Can't see ${fullName}. Either it doesn't exist, or your sign-in didn't include private-repo access — sign out and back in to re-grant it.`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'error',
      message: `GitHub rejected the request: ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`,
    };
  }

  const body = (await res.json().catch(() => null)) as {
    permissions?: RepoPermissions;
  } | null;

  if (canConnectWithPermissions(body?.permissions)) {
    return { ok: true, via: 'write-access' };
  }

  return {
    ok: false,
    code: 'read-only',
    message: `You can read ${fullName} but not write to it, so it isn't yours to sync. Everything in a connected repository is read as your career history, and read access to a public repo is something everyone has. Connect a repository you can push to, or install the GitHub App on this one.`,
  };
}

/** Records an installation against a user, replacing any earlier row for the same id. */
export async function recordInstallation(input: {
  id: number;
  userId: string;
  accountLogin: string;
  targetType: string;
  repositorySelection: string;
}): Promise<void> {
  await db
    .insert(githubInstallations)
    .values({ ...input, removedAt: null })
    .onConflictDoUpdate({
      target: githubInstallations.id,
      set: {
        // Re-installing after a removal, or installing on a second account, must clear
        // the tombstone rather than leave a row that reads as removed.
        userId: input.userId,
        accountLogin: input.accountLogin,
        targetType: input.targetType,
        repositorySelection: input.repositorySelection,
        removedAt: null,
      },
    });
}

/** Marks an installation gone. Never deletes: the audit trail is worth more than the row. */
export async function markInstallationRemoved(installationId: number): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ removedAt: new Date() })
    .where(eq(githubInstallations.id, installationId));
}
