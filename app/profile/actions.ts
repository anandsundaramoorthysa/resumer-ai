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
import {
  answerEnrichmentQuestion,
  dismissEnrichmentQuestion,
} from '@/lib/server/enrichment';
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

/* ------------------------------- answering what the last draft could not ---- */

/**
 * The third queue on this page, and its actions live here with the other two on purpose.
 *
 * All three are the same transaction between the system and the person: something is
 * outstanding, and only they can settle it. The review queue asks "is this yours?", the
 * flagged list asks "is this still yours?", and this one asks for the fact that no
 * amount of rewriting could invent. Splitting them across files would be the first step
 * toward splitting them across screens, and a user who has learned to check one would
 * have two they never see.
 *
 * The rules — when a question appears, when it disappears, what an answer becomes — are
 * in lib/server/enrichment.ts, beside the writes that apply them.
 */
export async function answerQuestion(
  questionId: string,
  answer: { scale?: string; outcome?: string; text?: string },
): Promise<Result> {
  const userId = await requireUserId();
  try {
    await answerEnrichmentQuestion(userId, questionId, answer);
    refresh();
    return { ok: true, message: 'Saved to your profile.' };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Something went wrong.',
    };
  }
}

export async function skipQuestion(questionId: string): Promise<void> {
  const userId = await requireUserId();
  await dismissEnrichmentQuestion(userId, questionId);
  refresh();
}
