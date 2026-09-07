/**
 * Server-side profile access — the boundary between the database and the engine.
 *
 * Every query is scoped by userId (NFR-6 / REQ-7.3), including while the app has a
 * single user, so opening this up later is a policy change rather than a migration.
 */

import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  applications,
  auditLog,
  contactInfo,
  profileRecords,
  resumeSnapshots,
  roles as rolesTable,
  users,
} from '@/lib/db/schema';
import type {
  ContactInfo,
  ProfileRecord,
  RecordSource,
  RoleRecord,
} from '@/lib/types';
import type { PipelineOutput } from '@/lib/pipeline/run';
import { latestCommitSha, parseRepoRef } from '@/lib/sync/github';
import { roleIdentity, splitMergedTitles } from '@/lib/sync/roles';
import type { ParseResult } from '@/lib/sync/parse';
import type { ParsedRecord } from '@/lib/sync/reconcile';
import { hashContent, reconcile, summarizePlan } from '@/lib/sync/reconcile';
import { getGithubToken } from '@/lib/server/github-token';

export interface LoadedProfile {
  contact: ContactInfo;
  records: ProfileRecord[];
  roles: RoleRecord[];
}

function rowToRecord(row: typeof profileRecords.$inferSelect): ProfileRecord {
  return {
    id: row.id,
    userId: row.userId,
    source: row.source as RecordSource,
    contentHash: row.contentHash,
    tags: row.tags ?? [],
    flaggedForRemoval: row.flaggedForRemoval,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    type: row.type,
    ...(row.data as Record<string, unknown>),
  } as ProfileRecord;
}

export async function loadProfileForUser(userId: string): Promise<LoadedProfile> {
  const [contactRow] = await db
    .select()
    .from(contactInfo)
    .where(eq(contactInfo.userId, userId))
    .limit(1);

  const recordRows = await db
    .select()
    .from(profileRecords)
    .where(eq(profileRecords.userId, userId));

  const roleRows = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.userId, userId))
    .orderBy(desc(rolesTable.startDate));

  return {
    contact: {
      fullName: contactRow?.fullName ?? '',
      email: contactRow?.email ?? '',
      phone: contactRow?.phone ?? undefined,
      location: contactRow?.location ?? undefined,
      portfolioUrl: contactRow?.portfolioUrl ?? undefined,
      githubUrl: contactRow?.githubUrl ?? undefined,
      linkedinUrl: contactRow?.linkedinUrl ?? undefined,
    },
    records: recordRows.map(rowToRecord),
    roles: roleRows.map((r) => ({
      id: r.id,
      userId: r.userId,
      title: r.title,
      company: r.company,
      location: r.location ?? undefined,
      startDate: r.startDate,
      endDate: r.endDate as string | 'present',
      source: r.source as RecordSource,
      contentHash: r.contentHash,
    })),
  };
}

/* ------------------------------------------------------------------ sync ---- */

/** Delegated so the token is decrypted in exactly one place — see github-token.ts. */
async function githubTokenFor(userId: string): Promise<string | null> {
  return getGithubToken(userId);
}

/**
 * Pre-draft sync check — REQ-2.2.
 *
 * Deliberately only the cheap half: compare the latest commit SHA against the last one
 * synced. A full extraction measured 1-3 minutes, which must not be wedged into the
 * front of a draft request; if the repo has moved on, the user is told so and can run a
 * sync (lib/sync/stepped.ts) rather than having the draft silently block on it.
 */
export function buildSyncStep(userId: string) {
  return async (): Promise<{ summary: string; records?: ProfileRecord[] }> => {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user?.portfolioRepo) {
      return { summary: 'No portfolio repo connected — using your saved profile.' };
    }

    const ref = parseRepoRef(user.portfolioRepo);
    const token = await githubTokenFor(userId);
    if (!ref || !token) {
      return { summary: 'GitHub not connected — using your saved profile.' };
    }

    const sha = await latestCommitSha(ref, token);
    if (sha === user.lastSyncedSha) {
      return { summary: 'Already up to date — no changes since your last sync.' };
    }

    return {
      summary:
        'Your portfolio has new commits. Drafting from your last synced profile — run a sync to pull the changes in.',
    };
  };
}

/**
 * Writes a parsed portfolio into the profile, applying the reconciliation policy:
 * add and update automatically, flag disappearances for review, never touch a manual
 * record (REQ-2.4).
 */
export async function applyParsedProfile(
  userId: string,
  parsed: ParseResult,
  sha: string | null,
): Promise<string> {
  // Roles first. The parser can only refer to a role by its content hash, but
  // lib/generate/assemble.ts groups bullets by real role id — so the hashes have to be
  // exchanged for row ids before any bullet is written, or every bullet lands in the
  // orphan bucket and the experience section comes out empty.
  const roleIdByHash = await syncRoles(userId, parsed.roles);
  const records = parsed.records.map((rec) => {
    const bullet = rec as unknown as { type: string; roleId?: string };
    if (bullet.type !== 'experience-bullet' || !bullet.roleId) return rec;
    const roleId = roleIdByHash.get(bullet.roleId);
    return roleId ? ({ ...rec, roleId } as ParsedRecord) : rec;
  });

  const existing = (
    await db.select().from(profileRecords).where(eq(profileRecords.userId, userId))
  ).map(rowToRecord);

  const plan = reconcile(existing, records);

  // Everything below is batched deliberately. One statement per record measured at
  // 34s for a 150-record portfolio — three times the whole step budget — and almost
  // all of it was round-trip latency to a remote database rather than real work.
  const audits: Array<{
    userId: string;
    recordId: string | null;
    action: string;
    source: string;
    diff: Record<string, unknown>;
  }> = [];

  // Deduped in place so the summary reports rows actually written. Two slices of one
  // file can yield the same fact, and counting the plan rather than the result made the
  // sync tell the user "163 added" when 161 rows landed.
  plan.toInsert = dedupeByHash(plan.toInsert);

  const inserts = plan.toInsert.map((rec) => {
    const { type, tags, contentHash, ...data } = rec as unknown as Record<
      string,
      unknown
    > & { type: string; tags: string[]; contentHash: string };
    audits.push({
      userId,
      recordId: null,
      action: 'create',
      source: 'github-sync',
      diff: { type },
    });
    return {
      userId,
      type,
      source: 'github-sync',
      contentHash,
      tags: tags ?? [],
      data: data as Record<string, unknown>,
    };
  });

  for (const chunk of chunked(inserts, 100)) {
    await db.insert(profileRecords).values(chunk).onConflictDoNothing();
  }

  // Updates each target one row by id, so they can't collapse into a single statement
  // — but they can go out concurrently instead of one round trip at a time.
  for (const chunk of chunked(plan.toUpdate, 20)) {
    await Promise.all(
      chunk.map(({ id, parsed: rec }) => {
        const { type, tags, contentHash, ...data } = rec as unknown as Record<
          string,
          unknown
        > & { type: string; tags: string[]; contentHash: string };
        audits.push({
          userId,
          recordId: id,
          action: 'update',
          source: 'github-sync',
          diff: { type },
        });
        return db
          .update(profileRecords)
          .set({
            contentHash,
            tags: tags ?? [],
            data: data as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(
            and(eq(profileRecords.id, id), eq(profileRecords.source, 'github-sync')),
          );
      }),
    );
  }

  // Flagging sets the same value on every row, so it really is one statement.
  for (const chunk of chunked(plan.toFlag, 200)) {
    await db
      .update(profileRecords)
      .set({ flaggedForRemoval: true, updatedAt: new Date() })
      .where(
        and(
          inArray(
            profileRecords.id,
            chunk.map((f) => f.id),
          ),
          eq(profileRecords.source, 'github-sync'),
        ),
      );
    for (const { id, reason } of chunk) {
      audits.push({
        userId,
        recordId: id,
        action: 'flag-removed',
        source: 'github-sync',
        diff: { reason },
      });
    }
  }

  for (const chunk of chunked(audits, 200)) {
    await db.insert(auditLog).values(chunk);
  }

  if (sha) {
    await db
      .update(users)
      .set({ lastSyncedSha: sha, lastSyncedAt: new Date() })
      .where(eq(users.id, userId));
  }

  return summarizePlan(plan);
}

/**
 * Inserts roles that aren't already stored and returns contentHash -> row id for all
 * of them, new and existing.
 *
 * The `role` table has no unique constraint on contentHash, so the previous
 * `onConflictDoNothing()` was a no-op: every sync appended a fresh copy of every role.
 * De-duplication has to happen here, in code, against what is already stored.
 */
async function syncRoles(
  userId: string,
  roles: ParseResult['roles'],
): Promise<Map<string, string>> {
  const stored = await db
    .select({
      id: rolesTable.id,
      contentHash: rolesTable.contentHash,
      title: rolesTable.title,
      company: rolesTable.company,
      startDate: rolesTable.startDate,
      endDate: rolesTable.endDate,
      location: rolesTable.location,
    })
    .from(rolesTable)
    .where(eq(rolesTable.userId, userId));

  const idByHash = new Map(stored.map((r) => [r.contentHash, r.id]));

  // Matching on content hash alone is what let 16 rows accumulate for 10 jobs: the same
  // company spelled two ways hashes two ways. An identity index alongside it means a
  // re-spelling updates the existing row instead of adding another.
  const idByIdentity = new Map(
    stored.map((r) => [roleIdentity(r.company, r.title), r.id]),
  );

  const pending: ParseResult['roles'] = [];
  for (const role of roles) {
    if (idByHash.has(role.contentHash)) continue;

    // A merged title ("AI Intern / Full Stack Developer") is several jobs, and each
    // half usually already exists as a correct row.
    const titles = splitMergedTitles(role.title);
    let matchedAll = true;
    for (const title of titles) {
      const existingId = idByIdentity.get(roleIdentity(role.company, title));
      if (existingId) {
        // Same job, better-spelled: point this parse at the row already there.
        idByHash.set(role.contentHash, existingId);
      } else {
        matchedAll = false;
      }
    }
    if (matchedAll && titles.length > 0) continue;

    if (pending.some((r) => roleIdentity(r.company, r.title) === roleIdentity(role.company, role.title))) {
      continue;
    }
    pending.push(role);
  }

  for (const chunk of chunked(pending, 100)) {
    const inserted = await db
      .insert(rolesTable)
      .values(
        chunk.map((role) => ({
          userId,
          title: role.title,
          company: role.company,
          location: role.location ?? null,
          startDate: role.startDate,
          endDate: role.endDate,
          source: 'github-sync',
          contentHash: role.contentHash,
        })),
      )
      .returning({ id: rolesTable.id, contentHash: rolesTable.contentHash });
    for (const row of inserted) {
      idByHash.set(row.contentHash, row.id);
    }
  }

  return idByHash;
}

/**
 * Drops repeats within one batch. `profile_record` is unique on (userId, contentHash),
 * and two slices of the same file can legitimately yield the same fact.
 */
function dedupeByHash(records: ParsedRecord[]): ParsedRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    if (seen.has(r.contentHash)) return false;
    seen.add(r.contentHash);
    return true;
  });
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------- persistence -- */

/** REQ-9.2 — freeze exactly what was produced, so the tracker can point at it. */
export async function persistDraft(
  userId: string,
  result: PipelineOutput,
): Promise<string> {
  const [snapshot] = await db
    .insert(resumeSnapshots)
    .values({
      userId,
      document: result.document as unknown as Record<string, unknown>,
      jobRequirement: (result.job ?? null) as unknown as Record<string, unknown> | null,
      score: result.score.overall,
      scoreDetail: result.score as unknown as Record<string, unknown>,
      recordHashSnapshot: result.document.recordHashSnapshot,
      renderMode: result.document.renderMode,
      fileName: result.files.pdfName,
    })
    .returning();

  await db.insert(applications).values({
    userId,
    resumeSnapshotId: snapshot.id,
    roleTitle: result.job?.roleTitle ?? 'Baseline resume',
    company: result.job?.company ?? '',
    category: result.job?.category ?? 'general',
    score: result.score.overall,
    status: 'draft',
  });

  return snapshot.id;
}

export async function audit(
  userId: string,
  recordId: string | null,
  action: string,
  source: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({ userId, recordId, action, source, diff });
}

export { hashContent };
