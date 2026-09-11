'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { CommitPayloadSchema, commitImport } from '@/lib/import/commit';
import { reviewImportCandidates, type ImportNote } from '@/lib/server/steward';

export interface ImportActionResult {
  ok: boolean;
  message: string;
  created?: number;
}

/**
 * The only path from an extracted candidate to a stored profile fact, and it is only
 * ever reached by the user pressing the confirm button (task 2.3).
 */
export async function commitImportAction(
  payload: unknown,
  source: 'resume' | 'linkedin' = 'resume',
): Promise<ImportActionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: 'Sign in first.' };

  const parsed = CommitPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      message: `That selection could not be read back: ${parsed.error.issues[0]?.message ?? 'invalid payload'}.`,
    };
  }

  if (parsed.data.records.length === 0 && parsed.data.roles.length === 0) {
    return { ok: false, message: 'Nothing is selected, so there is nothing to add.' };
  }

  try {
    const summary = await commitImport(
      userId,
      parsed.data,
      source === 'linkedin' ? 'linkedin' : 'ai-import',
    );
    revalidatePath('/profile');
    revalidatePath('/');
    return { ok: true, message: summary.message, created: summary.created };
  } catch (err) {
    return {
      ok: false,
      message: `Could not save: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`,
    };
  }
}

/**
 * What the steward says about an import before it is committed — STEWARD.md.
 *
 * Advice only, and never fatal: an import whose check cannot run is still an import.
 */
export async function reviewImportAction(
  candidates: Array<{ key: string; type: string; record: Record<string, unknown> }>,
): Promise<Record<string, ImportNote>> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId || !Array.isArray(candidates) || candidates.length === 0) return {};
  try {
    return await reviewImportCandidates(userId, candidates.slice(0, 200));
  } catch (err) {
    console.error('[import] steward review failed:', err);
    return {};
  }
}
