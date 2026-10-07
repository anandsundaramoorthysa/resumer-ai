'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { isOwnerSession } from '@/lib/server/approval';
import { createInvite, setInviteDisabled } from '@/lib/legal/invites';

export interface CreateInviteResult {
  ok: boolean;
  message: string;
  /** The plaintext code, returned this once and never stored. */
  code?: string;
}

/** Owner-only, proved on every call (a server action is a public endpoint). */
export async function createInviteAction(input: {
  label: string;
  maxUses: number;
  expiresOn: string;
}): Promise<CreateInviteResult> {
  const session = await auth();
  if (!(await isOwnerSession(session)) || !session?.user?.id) return { ok: false, message: 'Not found.' };

  let expiresAt: Date | null = null;
  if (input.expiresOn) {
    // End of the chosen day in India (UTC+5:30).
    expiresAt = new Date(`${input.expiresOn}T23:59:59+05:30`);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return { ok: false, message: 'Pick an expiry date in the future, or leave it empty.' };
    }
  }
  const maxUses = Number(input.maxUses);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000) {
    return { ok: false, message: 'Max uses must be a whole number from 1 to 10000.' };
  }
  const code = await createInvite({ label: String(input.label ?? ''), maxUses, expiresAt, createdBy: session.user.id });
  revalidatePath('/admin/invites');
  return { ok: true, message: 'Created. Copy it now: it cannot be shown again.', code };
}

export async function setInviteDisabledAction(id: string, disabled: boolean): Promise<{ ok: boolean }> {
  const session = await auth();
  if (!(await isOwnerSession(session)) || typeof id !== 'string') return { ok: false };
  await setInviteDisabled(id, Boolean(disabled));
  revalidatePath('/admin/invites');
  return { ok: true };
}
