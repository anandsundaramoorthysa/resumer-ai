/**
 * Approving and rejecting what a sync proposed.
 *
 * A sync no longer writes new claims into the profile; it writes proposals, and this is
 * where they become facts or stop existing. The reasoning is in lib/sync/reconcile.ts:
 * a portfolio repository is parsed by an LLM, an LLM does what the text it reads tells
 * it to, and the profile is what every later check measures against — so a repository
 * that could write to it directly could write its own grounding evidence.
 *
 * Two decisions here are worth stating, because both differ from the flagged-record
 * review next door in app/profile/actions.ts:
 *
 *   1. Approving keeps `source: 'github-sync'`. Keeping a flagged record promotes it to
 *      `manual`, because there the user is overruling the parser and should not have to
 *      do it twice. Here they are agreeing with it, so later syncs should go on keeping
 *      the record current — promoting it would freeze the fact at today's wording and
 *      quietly turn the portfolio connection off one record at a time.
 *
 *   2. Rejecting does not delete. The row stays as a tombstone with
 *      `reviewState: 'rejected'`, which is the only thing that stops the next sync
 *      re-proposing a claim that is still sitting in the repository. Deleting it would
 *      make the review queue refill with the same items on every sync, and a queue that
 *      cannot be emptied gets approved wholesale, which is the same as no review at all.
 */

import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { audit } from '@/lib/server/profile';

export interface ReviewOutcome {
  records: number;
  roles: number;
}

/** Ids of this user's roles that are still awaiting review. */
async function pendingRoleIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.userId, userId), eq(rolesTable.reviewState, 'pending')));
  return new Set(rows.map((r) => r.id));
}

/** The pending bullets attached to a set of roles. */
async function pendingBulletIdsForRoles(
  userId: string,
  roleIds: string[],
): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const rows = await db
    .select({ id: profileRecords.id, data: profileRecords.data })
    .from(profileRecords)
    .where(
      and(
        eq(profileRecords.userId, userId),
        eq(profileRecords.reviewState, 'pending'),
        eq(profileRecords.type, 'experience-bullet'),
      ),
    );
  const wanted = new Set(roleIds);
  return rows
    .filter((r) => wanted.has(String((r.data as Record<string, unknown>).roleId ?? '')))
    .map((r) => r.id);
}

async function setRecordState(
  userId: string,
  ids: string[],
  state: 'approved' | 'rejected',
): Promise<number> {
  if (ids.length === 0) return 0;
  const updated = await db
    .update(profileRecords)
    .set({ reviewState: state, updatedAt: new Date() })
    .where(
      and(
        eq(profileRecords.userId, userId),
        inArray(profileRecords.id, ids),
        // Only a proposal can be decided. Without this an id from a stale page could
        // re-open a settled record, and "approve" would be a way to un-reject one.
        eq(profileRecords.reviewState, 'pending'),
      ),
    )
    .returning({ id: profileRecords.id, type: profileRecords.type });

  for (const row of updated) {
    await audit(userId, row.id, 'update', 'manual', {
      reviewState: state,
      type: row.type,
      decidedByUser: true,
    });
  }
  return updated.length;
}

async function setRoleState(
  userId: string,
  ids: string[],
  state: 'approved' | 'rejected',
): Promise<number> {
  if (ids.length === 0) return 0;
  const updated = await db
    .update(rolesTable)
    .set({ reviewState: state })
    .where(
      and(
        eq(rolesTable.userId, userId),
        inArray(rolesTable.id, ids),
        eq(rolesTable.reviewState, 'pending'),
      ),
    )
    .returning({ id: rolesTable.id });

  for (const row of updated) {
    await audit(userId, row.id, 'update', 'manual', {
      reviewState: state,
      type: 'role',
      decidedByUser: true,
    });
  }
  return updated.length;
}

/**
 * Approves proposed records, and the roles they hang off.
 *
 * A bullet is meaningless without its role: lib/generate/assemble.ts drops any bullet
 * whose roleId matches nothing, so approving "Cut p95 latency 62%" while its job sits
 * unapproved would produce a record that can never appear on a resume and no
 * explanation of why. Approving the achievement is approving the job, so it says so.
 */
export async function approveProposedRecords(
  userId: string,
  recordIds: string[],
): Promise<ReviewOutcome> {
  const pendingRoles = await pendingRoleIds(userId);

  const rows =
    recordIds.length > 0
      ? await db
          .select({ id: profileRecords.id, type: profileRecords.type, data: profileRecords.data })
          .from(profileRecords)
          .where(
            and(
              eq(profileRecords.userId, userId),
              inArray(profileRecords.id, recordIds),
              eq(profileRecords.reviewState, 'pending'),
            ),
          )
      : [];

  const rolesToApprove = [
    ...new Set(
      rows
        .filter((r) => r.type === 'experience-bullet')
        .map((r) => String((r.data as Record<string, unknown>).roleId ?? ''))
        .filter((id) => pendingRoles.has(id)),
    ),
  ];

  const roles = await setRoleState(userId, rolesToApprove, 'approved');
  const records = await setRecordState(userId, recordIds, 'approved');
  return { records, roles };
}

/** Rejects proposed records. Roles are untouched — a bad bullet is not a bad job. */
export async function rejectProposedRecords(
  userId: string,
  recordIds: string[],
): Promise<ReviewOutcome> {
  const records = await setRecordState(userId, recordIds, 'rejected');
  return { records, roles: 0 };
}

/** Approves proposed roles. The bullets under them are decided separately. */
export async function approveProposedRoles(
  userId: string,
  roleIds: string[],
): Promise<ReviewOutcome> {
  const roles = await setRoleState(userId, roleIds, 'approved');
  return { records: 0, roles };
}

/**
 * Rejects proposed roles, and every proposal that belongs to one.
 *
 * Saying "I never worked there" has to take the achievements with it. Leaving them
 * behind would mean rejecting an invented employer and then being asked, one at a time,
 * about the things it claims you did there.
 */
export async function rejectProposedRoles(
  userId: string,
  roleIds: string[],
): Promise<ReviewOutcome> {
  const bulletIds = await pendingBulletIdsForRoles(userId, roleIds);
  const records = await setRecordState(userId, bulletIds, 'rejected');
  const roles = await setRoleState(userId, roleIds, 'rejected');
  return { records, roles };
}

/**
 * Decides everything outstanding in one action.
 *
 * Not a convenience. A first sync of a real portfolio proposes on the order of a
 * hundred and fifty records, and a queue that can only be emptied a hundred and fifty
 * clicks at a time is one users abandon — at which point their profile stays empty and
 * the review has protected nothing. One button, with the repository named next to it,
 * is still a human decision about a specific repository; that is the thing that matters.
 */
export async function decideAllProposed(
  userId: string,
  decision: 'approved' | 'rejected',
): Promise<ReviewOutcome> {
  const recordRows = await db
    .select({ id: profileRecords.id })
    .from(profileRecords)
    .where(
      and(eq(profileRecords.userId, userId), eq(profileRecords.reviewState, 'pending')),
    );
  const roleRows = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.userId, userId), eq(rolesTable.reviewState, 'pending')));

  const records = await setRecordState(userId, recordRows.map((r) => r.id), decision);
  const roles = await setRoleState(userId, roleRows.map((r) => r.id), decision);
  return { records, roles };
}
