'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { profileRecords } from '@/lib/db/schema';
import { audit } from '@/lib/server/profile';
import {
  approveProposedRecords,
  approveProposedRoles,
  decideAllProposed,
  rejectProposedRecords,
  rejectProposedRoles,
} from '@/lib/server/sync-review';

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
 * Resolves a flagged record by keeping it: clears the flag and promotes it to a manual
 * record, so a later sync can never flag or overwrite it again. Deliberate: if you have
 * explicitly said "keep this", the parser doesn't get another vote.
 */
export async function keepRecord(recordId: string): Promise<void> {
  const userId = await requireUserId();
  await db
    .update(profileRecords)
    .set({ flaggedForRemoval: false, source: 'manual', updatedAt: new Date() })
    .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)));
  await audit(userId, recordId, 'update', 'manual', { keptAfterFlag: true });
  revalidatePath('/profile');
  revalidatePath('/settings/portfolio');
  revalidatePath('/');
}

/** Confirms a removal. Only ever reached by explicit user action, never by a sync. */
export async function removeRecord(recordId: string): Promise<void> {
  const userId = await requireUserId();
  await db
    .delete(profileRecords)
    .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)));
  await audit(userId, recordId, 'delete', 'manual', { confirmedByUser: true });
  revalidatePath('/profile');
  revalidatePath('/settings/portfolio');
  revalidatePath('/');
}

/* --------------------------------------- reviewing what a sync proposed ---- */

/**
 * The other review on this page, and deliberately its neighbour rather than its own
 * screen. Both ask the same question about the same kind of row — one about a fact that
 * disappeared from the portfolio, one about a fact that appeared in it — and splitting
 * them across two places would mean a user who has learned to check one still has an
 * unread queue in the other.
 *
 * The rules these enforce live in lib/server/sync-review.ts, next to the SQL that
 * applies them.
 */
export async function approveSyncedRecord(recordId: string): Promise<void> {
  const userId = await requireUserId();
  await approveProposedRecords(userId, [recordId]);
  refresh();
}

export async function rejectSyncedRecord(recordId: string): Promise<void> {
  const userId = await requireUserId();
  await rejectProposedRecords(userId, [recordId]);
  refresh();
}

export async function approveSyncedRole(roleId: string): Promise<void> {
  const userId = await requireUserId();
  await approveProposedRoles(userId, [roleId]);
  refresh();
}

export async function rejectSyncedRole(roleId: string): Promise<void> {
  const userId = await requireUserId();
  await rejectProposedRoles(userId, [roleId]);
  refresh();
}

export async function approveAllSynced(): Promise<void> {
  const userId = await requireUserId();
  await decideAllProposed(userId, 'approved');
  refresh();
}

export async function rejectAllSynced(): Promise<void> {
  const userId = await requireUserId();
  await decideAllProposed(userId, 'rejected');
  refresh();
}
