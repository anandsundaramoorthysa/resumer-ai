'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { parseRepoRef, latestCommitSha } from '@/lib/sync/github';
import { accounts } from '@/lib/db/schema';
import { and } from 'drizzle-orm';

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
 * Saves the portfolio repo, but only after proving we can actually read it.
 * Storing an unreadable repo would turn every future draft into a confusing
 * "sync failed" — better to fail here, once, with a specific reason.
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

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'github')))
    .limit(1);

  if (!account?.access_token) {
    return {
      ok: false,
      message: 'No GitHub token on your account. Sign out and sign in again to grant repo access.',
    };
  }

  try {
    await latestCommitSha(ref, account.access_token);
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
    message: `Connected ${ref.owner}/${ref.repo}. Run a sync to pull your profile in.`,
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
