'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { applications } from '@/lib/db/schema';

const STATUSES = ['draft', 'applied', 'interview', 'rejected', 'offer'] as const;
export type ApplicationStatus = (typeof STATUSES)[number];

export async function setApplicationStatus(
  id: string,
  status: ApplicationStatus,
): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Not signed in.');
  // A server action's arguments come from the browser; the type above checks nothing.
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error('Unknown status.');

  await db
    .update(applications)
    .set({
      status,
      // Stamped the first time it leaves draft and kept after that, so moving from
      // Applied to Interview does not rewrite when it was sent. Every change used to
      // reset it to now. Back to Draft clears it: the user is saying it was never sent,
      // which also makes its resume editable again (app/api/resume/[snapshotId]).
      appliedAt: status === 'draft' ? null : sql`coalesce(${applications.appliedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(and(eq(applications.id, id), eq(applications.userId, userId)));

  revalidatePath('/applications');
  revalidatePath('/');
}
