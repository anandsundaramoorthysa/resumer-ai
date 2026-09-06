/**
 * Server-side profile access — the boundary between the database and the engine.
 *
 * Every query is scoped by userId (NFR-6 / REQ-7.3), including while the app has a
 * single user, so opening this up later is a policy change rather than a migration.
 */

import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  accounts,
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
import type { ParseResult } from '@/lib/sync/parse';
import { hashContent, reconcile, summarizePlan } from '@/lib/sync/reconcile';

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

async function githubTokenFor(userId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'github')))
    .limit(1);
  return row?.access_token ?? null;
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
  const existing = (
    await db.select().from(profileRecords).where(eq(profileRecords.userId, userId))
  ).map(rowToRecord);

  const plan = reconcile(existing, parsed.records);

  for (const rec of plan.toInsert) {
    const { type, tags, contentHash, ...data } = rec as unknown as Record<string, unknown> & {
      type: string;
      tags: string[];
      contentHash: string;
    };
    await db
      .insert(profileRecords)
      .values({
        userId,
        type,
        source: 'github-sync',
        contentHash,
        tags: tags ?? [],
        data: data as Record<string, unknown>,
      })
      .onConflictDoNothing();
    await audit(userId, null, 'create', 'github-sync', { type });
  }

  for (const { id, parsed: rec } of plan.toUpdate) {
    const { type, tags, contentHash, ...data } = rec as unknown as Record<string, unknown> & {
      type: string;
      tags: string[];
      contentHash: string;
    };
    await db
      .update(profileRecords)
      .set({
        contentHash,
        tags: tags ?? [],
        data: data as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(and(eq(profileRecords.id, id), eq(profileRecords.source, 'github-sync')));
    await audit(userId, id, 'update', 'github-sync', { type });
  }

  for (const { id, reason } of plan.toFlag) {
    await db
      .update(profileRecords)
      .set({ flaggedForRemoval: true, updatedAt: new Date() })
      .where(and(eq(profileRecords.id, id), eq(profileRecords.source, 'github-sync')));
    await audit(userId, id, 'flag-removed', 'github-sync', { reason });
  }

  for (const role of parsed.roles) {
    await db
      .insert(rolesTable)
      .values({
        userId,
        title: role.title,
        company: role.company,
        startDate: role.startDate,
        endDate: role.endDate,
        source: 'github-sync',
        contentHash: role.contentHash,
      })
      .onConflictDoNothing();
  }

  if (sha) {
    await db
      .update(users)
      .set({ lastSyncedSha: sha, lastSyncedAt: new Date() })
      .where(eq(users.id, userId));
  }

  return summarizePlan(plan);
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
