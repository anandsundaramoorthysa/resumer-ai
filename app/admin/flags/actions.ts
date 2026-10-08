'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { isOwnerSession } from '@/lib/server/approval';
import { redirect } from 'next/navigation';
import { FLAG_KEYS, FlagValueError, setFlag, type FlagKey } from '@/lib/server/flags';

/**
 * Sets one switch — the owner's call, proved on every POST (a server action is an endpoint
 * anyone can hit, whatever page rendered the button). Writes an audit_log row.
 */
export async function setFlagAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!(await isOwnerSession(session)) || !session?.user?.id) return;
  const key = String(formData.get('key') ?? '');
  const value = String(formData.get('value') ?? '');
  if (!(FLAG_KEYS as readonly string[]).includes(key)) return;
  try {
    await setFlag(key as FlagKey, value, session.user.id);
  } catch (err) {
    if (!(err instanceof FlagValueError)) throw err;
    redirect(`/admin/flags?error=${encodeURIComponent(err.message)}`);
  }
  revalidatePath('/admin/flags');
  redirect('/admin/flags');
}
