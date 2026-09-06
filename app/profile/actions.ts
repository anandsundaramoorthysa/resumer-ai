'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { profileRecords } from '@/lib/db/schema';
import { audit } from '@/lib/server/profile';

async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
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
