'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { decide, isOwnerSession } from '@/lib/server/approval';

export interface DecisionResult {
  ok: boolean;
  message: string;
}

/**
 * Approves or denies an account — the owner's decision, and nobody else's.
 *
 * Proved here, on every call, rather than trusted from the page that rendered the button:
 * a server action is an endpoint anyone can POST to, whatever page it came from.
 */
export async function decideAccountAction(userId: string, decision: 'approved' | 'denied'): Promise<DecisionResult> {
  const session = await auth();
  if (!(await isOwnerSession(session))) return { ok: false, message: 'Not found.' };
  if (decision !== 'approved' && decision !== 'denied') return { ok: false, message: 'Unknown decision.' };
  if (typeof userId !== 'string' || !userId) return { ok: false, message: 'No account given.' };

  const done = await decide(userId, decision);
  if (!done) return { ok: false, message: 'That account no longer exists, or cannot be changed here.' };
  revalidatePath('/admin/approvals');
  return {
    ok: true,
    message: `${done.email ?? 'The account'} was ${decision === 'approved' ? 'approved' : 'denied'}, and has been told by email.`,
  };
}
