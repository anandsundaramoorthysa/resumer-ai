/**
 * Reading and writing the marks left by a removal — the database half of
 * lib/profile/dismissals.ts.
 *
 * Three rules hold everything together:
 *
 *   ONE MARK PER FACT      `(userId, contentHash)` is unique, so removing the same thing
 *                          twice updates the mark instead of failing the second delete.
 *   THE MARK CARRIES IT    the snapshot is the whole row, its id included, so bringing it
 *                          back restores the same row rather than a copy. That matters for
 *                          a job: its accomplishments point at it by id, so a job restored
 *                          under a new id would leave every one of them orphaned.
 *   SAYING IT AGAIN CLEARS IT   typing the fact back in yourself lifts the block, or the
 *                          Removed list would keep claiming to hold back something already
 *                          on the profile.
 */

import { and, desc, eq, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  auditLog,
  dismissedRecords as dismissed,
  profileRecords,
  roles as rolesTable,
} from '@/lib/db/schema';
import type { Dismissal } from '@/lib/profile/dismissals';
import { identityKeyOf } from '@/lib/sync/reconcile';
import { roleIdentity } from '@/lib/sync/roles';
import type { ProfileRecord } from '@/lib/types';

export type DismissedKind = 'record' | 'role';

export interface DismissedItem {
  id: string;
  kind: DismissedKind;
  type: string;
  label: string;
  source: string;
  createdAt: Date;
}

type RecordRow = typeof profileRecords.$inferSelect;
type RoleRow = typeof rolesTable.$inferSelect;

/* ------------------------------------------------------------------ reading -- */

/** Every mark, for the planners. Two columns only: this runs inside the sync's budget. */
export async function loadDismissals(userId: string): Promise<Dismissal[]> {
  return db
    .select({ contentHash: dismissed.contentHash, identityKey: dismissed.identityKey })
    .from(dismissed)
    .where(eq(dismissed.userId, userId));
}

/** The Removed list, newest first. */
export async function listDismissed(userId: string): Promise<DismissedItem[]> {
  const rows = await db
    .select({
      id: dismissed.id,
      kind: dismissed.kind,
      type: dismissed.type,
      label: dismissed.label,
      source: dismissed.source,
      createdAt: dismissed.createdAt,
    })
    .from(dismissed)
    .where(eq(dismissed.userId, userId))
    .orderBy(desc(dismissed.createdAt));
  return rows.map((r) => ({ ...r, kind: r.kind as DismissedKind }));
}

/* ------------------------------------------------------------------ writing -- */

/**
 * Remember that a record was removed.
 *
 * Takes the row rather than an id because the caller has just deleted it — reading it back
 * afterwards would find nothing, and reading it before inside the same transaction is what
 * every delete path already does.
 */
export async function dismissRecordRow(userId: string, row: RecordRow): Promise<void> {
  const record = { ...(row.data as object), id: row.id, type: row.type } as ProfileRecord;
  await write(userId, {
    kind: 'record',
    type: row.type,
    contentHash: row.contentHash,
    identityKey: safeIdentity(record),
    label: labelOf(row.type, row.data as Record<string, unknown>),
    snapshot: {
      id: row.id,
      type: row.type,
      data: row.data,
      tags: row.tags,
      contentHash: row.contentHash,
      source: row.source,
    },
    source: row.source,
  });
}

/** The same, for a job. */
export async function dismissRoleRow(userId: string, row: RoleRow): Promise<void> {
  await write(userId, {
    kind: 'role',
    type: 'role',
    contentHash: row.contentHash,
    identityKey: `role:${roleIdentity(row.company, row.title)}`,
    label: `${row.title} — ${row.company}`,
    snapshot: {
      id: row.id,
      title: row.title,
      company: row.company,
      startDate: row.startDate,
      endDate: row.endDate,
      location: row.location,
      contentHash: row.contentHash,
      source: row.source,
    },
    source: row.source,
  });
}

/**
 * The user wrote it back in themselves, so the block is no longer theirs to want.
 *
 * By identity as well as by fingerprint: someone retyping a removed line rarely reproduces
 * it character for character, and a block that survived the rewrite would quietly keep the
 * portfolio's version out while the Removed list still offered to restore it.
 */
export async function forgetDismissalFor(
  userId: string,
  keys: { contentHash: string; identityKey?: string | null },
): Promise<void> {
  const matches = keys.identityKey
    ? or(eq(dismissed.contentHash, keys.contentHash), eq(dismissed.identityKey, keys.identityKey))
    : eq(dismissed.contentHash, keys.contentHash);
  await db.delete(dismissed).where(and(eq(dismissed.userId, userId), matches));
}

/** The keys a record would be blocked by — for callers holding data rather than a row. */
export function dismissalKeysFor(
  type: string,
  data: Record<string, unknown>,
  contentHash: string,
): { contentHash: string; identityKey: string | null } {
  return {
    contentHash,
    identityKey: safeIdentity({ ...data, type } as unknown as ProfileRecord),
  };
}

/** "Allow it again": lift the block, restore nothing. The next sync may propose it. */
export async function forgetDismissal(userId: string, id: string): Promise<string> {
  const [row] = await db
    .delete(dismissed)
    .where(and(eq(dismissed.userId, userId), eq(dismissed.id, id)))
    .returning({ label: dismissed.label });
  if (!row) throw new Error('That entry is no longer on this list.');
  await note(userId, null, 'dismissal-forget', { label: row.label });
  return row.label;
}

/**
 * "Bring it back": the row returns under its own id, approved, and the mark goes.
 *
 * Approved rather than pending because the user asking for it back IS the decision — a
 * restored row that reappeared in the approve/deny queue would ask the same question twice.
 */
export async function restoreDismissal(userId: string, id: string): Promise<string> {
  const [row] = await db
    .select()
    .from(dismissed)
    .where(and(eq(dismissed.userId, userId), eq(dismissed.id, id)))
    .limit(1);
  if (!row) throw new Error('That entry is no longer on this list.');
  const snap = row.snapshot as Record<string, unknown>;

  if (row.kind === 'role') {
    await db
      .insert(rolesTable)
      .values({
        id: String(snap.id),
        userId,
        title: String(snap.title ?? ''),
        company: String(snap.company ?? ''),
        startDate: String(snap.startDate ?? ''),
        endDate: String(snap.endDate ?? 'present'),
        location: snap.location == null ? null : String(snap.location),
        source: String(snap.source ?? 'manual'),
        contentHash: String(snap.contentHash ?? row.contentHash),
        reviewState: 'approved',
      })
      .onConflictDoNothing();
  } else {
    // A bullet points at its job by id. If that job was removed too and not yet brought
    // back, restoring the line would hide it under a job that no longer exists — so say
    // which order to do it in rather than storing an invisible row.
    const data = (snap.data ?? {}) as Record<string, unknown>;
    if (row.type === 'experience-bullet' && typeof data.roleId === 'string') {
      const [job] = await db
        .select({ id: rolesTable.id })
        .from(rolesTable)
        .where(and(eq(rolesTable.id, data.roleId), eq(rolesTable.userId, userId)))
        .limit(1);
      if (!job) throw new Error('Bring the job back first — this line belongs to it.');
    }
    await db
      .insert(profileRecords)
      .values({
        id: String(snap.id),
        userId,
        type: row.type,
        source: String(snap.source ?? 'manual'),
        contentHash: String(snap.contentHash ?? row.contentHash),
        tags: (snap.tags as string[]) ?? [],
        data,
        reviewState: 'approved',
        flaggedForRemoval: false,
      })
      .onConflictDoNothing();
  }

  await db.delete(dismissed).where(and(eq(dismissed.userId, userId), eq(dismissed.id, id)));
  await note(userId, row.kind === 'role' ? null : String(snap.id), 'dismissal-restore', {
    type: row.type,
    label: row.label,
  });
  return row.label;
}

/** Removing a job removes its lines; this marks them in one statement rather than N. */
export async function dismissBulletRows(userId: string, rows: RecordRow[]): Promise<void> {
  for (const row of rows) await dismissRecordRow(userId, row);
}

/* ------------------------------------------------------------------- internal -- */

async function write(
  userId: string,
  mark: {
    kind: DismissedKind;
    type: string;
    contentHash: string;
    identityKey: string | null;
    label: string;
    snapshot: Record<string, unknown>;
    source: string;
  },
): Promise<void> {
  await db
    .insert(dismissed)
    .values({ userId, ...mark })
    // Removed, brought back, removed again: the newest snapshot is the one to keep.
    .onConflictDoUpdate({
      target: [dismissed.userId, dismissed.contentHash],
      set: {
        kind: mark.kind,
        type: mark.type,
        identityKey: mark.identityKey,
        label: mark.label,
        snapshot: mark.snapshot,
        source: mark.source,
        createdAt: new Date(),
      },
    });
}

/**
 * `identityKeyOf` throws on a shape it does not recognise — a half-written record, or a
 * type it has no key for. A mark without an identity still blocks by fingerprint, which is
 * a smaller net but never a wrong one, so a missing key is not worth failing a delete over.
 */
function safeIdentity(record: ProfileRecord): string | null {
  // A summary's identity is the literal string "summary" — there is one summary slot, and
  // reconcile uses that to let the newest extraction win. As a block it would mean
  // "never accept a summary again, whatever it says", which is not what removing one
  // sentence asked for. Fingerprint only, so exactly the removed text stays out.
  if (record.type === 'summary') return null;
  try {
    return identityKeyOf(record) || null;
  } catch {
    return null;
  }
}

/** The first thing on the row that names it, for the Removed list. */
function labelOf(type: string, data: Record<string, unknown>): string {
  for (const key of ['title', 'name', 'text', 'credential', 'role', 'institution']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  }
  return type;
}

async function note(
  userId: string,
  recordId: string | null,
  action: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({ userId, recordId, action, source: 'manual', diff });
}
