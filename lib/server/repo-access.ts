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
