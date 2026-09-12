'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { forgetDismissal, restoreDismissal } from '@/lib/server/dismissals';
import type { Result } from './record-actions';

async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

function refresh(): void {
  revalidatePath('/profile');
  revalidatePath('/settings/portfolio');
  revalidatePath('/');
}

/**
 * The two ways out of a removal, and they are genuinely different answers.
 *
 * "Bring it back" says the removal was a mistake: the entry returns as it was, and the
 * block goes with it. "Allow it again" says the removal was right at the time but the
 * source may now have a better version — nothing is restored, and the next sync is free to
 * propose it. Offering only the first would make someone restore a stale line in order to
 * let a fresh one through.
 */
export async function bringBack(id: string): Promise<Result> {
  try {
    const label = await restoreDismissal(await requireUserId(), id);
    refresh();
    return { ok: true, message: `Back on your profile: ${label}` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error && err.constructor === Error ? err.message : 'That could not be restored.',
    };
  }
}

export async function allowAgain(id: string): Promise<Result> {
  try {
    const label = await forgetDismissal(await requireUserId(), id);
    refresh();
    return { ok: true, message: `A future sync may add this again: ${label}` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error && err.constructor === Error ? err.message : 'That could not be changed.',
    };
  }
}
