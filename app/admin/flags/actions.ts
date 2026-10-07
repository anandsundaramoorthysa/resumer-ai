'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { isOwnerSession } from '@/lib/server/approval';
import { FLAG_KEYS, setFlag, type FlagKey } from '@/lib/server/flags';

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
  await setFlag(key as FlagKey, value, session.user.id);
  revalidatePath('/admin/flags');
}
