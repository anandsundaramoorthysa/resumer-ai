'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { applications } from '@/lib/db/schema';

export type ApplicationStatus =
  | 'draft'
  | 'applied'
  | 'interview'
  | 'rejected'
  | 'offer';

export async function setApplicationStatus(
  id: string,
  status: ApplicationStatus,
): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Not signed in.');

  await db
    .update(applications)
    .set({
      status,
      // Stamped the first time it leaves draft, so the tracker records when it was
      // actually sent rather than when the row was created.
      appliedAt: status === 'draft' ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(applications.id, id), eq(applications.userId, userId)));

  revalidatePath('/applications');
  revalidatePath('/');
}
