'use server';

import { canConnectRepo, getRepoAccess } from '@/lib/server/repo-access';
import { isGitHubAppConfigured } from '@/lib/github/app';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { parseRepoRef, latestCommitSha } from '@/lib/sync/github';

export interface ActionResult {
  ok: boolean;
  message: string;
}

async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/**
 * Saves the portfolio repo, but only after proving two things: that this user has any
 * business connecting it, and that we can actually read it.
 *
 * The first check is new. This used to accept any repository the user's token could
 * read, and an OAuth `repo` grant reads every public repository on GitHub — so the
 * field accepted a stranger's repo, and the sync then parsed that stranger's files with
 * an LLM and wrote the results into this user's profile. `canConnectRepo` requires push
 * access or a GitHub App installation; the reasoning, including why read access is the
 * wrong test and how organisation-hosted portfolios still work, is in
 * lib/server/repo-access.ts.
 *
 * The second check is the original one: storing an unreadable repo would turn every
 * future draft into a confusing "sync failed" — better to fail here, once, with a
 * specific reason.
 */
export async function connectRepo(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const userId = await requireUserId();
  const input = String(formData.get('repo') ?? '').trim();

  if (!input) return { ok: false, message: 'Enter a repository, e.g. owner/name.' };

  const ref = parseRepoRef(input);
  if (!ref) {
    return {
      ok: false,
      message: `"${input}" doesn't look like a repository. Use owner/name or a GitHub URL.`,
    };
  }

  const verdict = await canConnectRepo(userId, { owner: ref.owner, name: ref.repo });
  if (!verdict.ok) return { ok: false, message: verdict.message };

  const access = await getRepoAccess(userId, { owner: ref.owner, name: ref.repo });

  if (!access) {
    return {
      ok: false,
      message: isGitHubAppConfigured()
        ? 'No read access to that repository yet. Install the GitHub App on it below.'
        : 'No GitHub token on your account. Sign out and sign in again to grant repo access.',
    };
  }

  try {
    await latestCommitSha(ref, access.token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404')) {
      return {
        ok: false,
        message: `Can't see ${ref.owner}/${ref.repo}. Either it doesn't exist, or your sign-in didn't include private-repo access — sign out and back in to re-grant it.`,
      };
    }
    return { ok: false, message: `GitHub rejected the request: ${msg.slice(0, 160)}` };
  }

  await db
    .update(users)
    .set({ portfolioRepo: `${ref.owner}/${ref.repo}`, lastSyncedSha: null })
    .where(eq(users.id, userId));

  revalidatePath('/settings/portfolio');
  revalidatePath('/');
  return {
    ok: true,
    message: `Connected ${ref.owner}/${ref.repo}. Run a sync — anything new it finds waits on your profile page for you to approve before it counts.`,
  };
}

/** Clears the connection. Records already pulled in are left alone. */
export async function disconnectRepo(): Promise<ActionResult> {
  const userId = await requireUserId();
  await db
    .update(users)
    .set({ portfolioRepo: null, lastSyncedSha: null, lastSyncedAt: null })
    .where(eq(users.id, userId));
  revalidatePath('/settings/portfolio');
  revalidatePath('/');
  return {
    ok: true,
    message: 'Disconnected. Records already pulled in stay in your profile.',
  };
}
