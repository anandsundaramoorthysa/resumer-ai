'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import {
  DuplicateRecordError,
  createBullet,
  createProject,
  createSkill,
  createSummary,
  createTypedRecord,
  updateTypedRecord,
  deleteRecord as removeRecord,
  setProjectMetrics,
  updateBullet,
} from '@/lib/profile/records';

export interface Result {
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
 * Every action funnels through here so a failure reaches the user as a sentence rather
 * than a stack trace, and so a duplicate reads as "you already have this" rather than a
 * constraint violation — the user did nothing wrong in that case.
 */
async function run(fn: () => Promise<void>, success: string): Promise<Result> {
  try {
    await fn();
    revalidatePath('/profile');
    revalidatePath('/');
    return { ok: true, message: success };
  } catch (err) {
    if (err instanceof DuplicateRecordError) return { ok: false, message: err.message };
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Something went wrong.',
    };
  }
}

export async function addBullet(
  roleId: string,
  action: string,
  scale: string,
  outcome: string,
): Promise<Result> {
  const userId = await requireUserId();
  return run(
    async () => {
      await createBullet(userId, { roleId, action, scale, outcome });
    },
    'Added.',
  );
}

export async function editBullet(
  recordId: string,
  roleId: string,
  action: string,
  scale: string,
  outcome: string,
): Promise<Result> {
  const userId = await requireUserId();
  return run(
    async () => {
      await updateBullet(userId, recordId, { roleId, action, scale, outcome });
    },
    'Saved.',
  );
}

export async function deleteProfileRecord(recordId: string): Promise<Result> {
  const userId = await requireUserId();
  return run(async () => {
    await removeRecord(userId, recordId);
  }, 'Removed.');
}

export async function addSkill(name: string, category: string): Promise<Result> {
  const userId = await requireUserId();
  return run(
    async () => {
      await createSkill(userId, {
        name,
        category: category as 'language' | 'framework' | 'tool' | 'platform' | 'soft-skill',
      });
    },
    'Skill added.',
  );
}

export async function addProject(
  name: string,
  description: string,
  stack: string,
): Promise<Result> {
  const userId = await requireUserId();
  return run(
    async () => {
      await createProject(userId, {
        name,
        description,
        stack: stack.split(',').map((s) => s.trim()).filter(Boolean),
        links: [],
        impactMetrics: [],
      });
    },
    'Project added.',
  );
}

export async function saveProjectMetrics(
  recordId: string,
  metrics: string[],
): Promise<Result> {
  const userId = await requireUserId();
  return run(
    async () => {
      await setProjectMetrics(userId, recordId, metrics);
    },
    'Outcome recorded.',
  );
}

export async function saveSummary(text: string): Promise<Result> {
  const userId = await requireUserId();
  return run(async () => {
    await createSummary(userId, text);
  }, 'Summary saved.');
}

/**
 * The generic path, used by every type in `RECORD_FORMS`.
 *
 * Values arrive as the raw strings the form held, and are coerced and validated on the
 * server by the same registry the form rendered from — the client's version of the rules
 * is a convenience, never the authority.
 */
export async function saveRecord(
  type: string,
  recordId: string | null,
  values: Record<string, string>,
): Promise<Result> {
  const userId = await requireUserId();
  return run(
    async () => {
      if (recordId) await updateTypedRecord(userId, recordId, type, values);
      else await createTypedRecord(userId, type, values);
    },
    recordId ? 'Saved.' : 'Added.',
  );
}
