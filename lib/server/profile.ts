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
import {
  fetchLiveSite,
  fetchPortfolioFiles,
  latestCommitSha,
  parseRepoRef,
} from '@/lib/sync/github';
import { parsePortfolio } from '@/lib/sync/parse';
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
 * Builds the pre-draft sync step (REQ-2.2). Returns undefined when the user hasn't
 * connected a repo yet, so drafting still works from a manually-entered profile.
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

    // --- The cheap gate (NFR-7): one API call decides everything else ---------
    const sha = await latestCommitSha(ref, token);
    if (sha === user.lastSyncedSha) {
      return { summary: 'Already up to date — no changes since your last draft.' };
    }

    const files = await fetchPortfolioFiles(ref, token, sha);
    const [contactRow] = await db
      .select()
      .from(contactInfo)
      .where(eq(contactInfo.userId, userId))
      .limit(1);
    const liveText = contactRow?.portfolioUrl
      ? await fetchLiveSite(contactRow.portfolioUrl)
      : null;

    const parsed = await parsePortfolio(files, liveText);
    const existing = (
      await db.select().from(profileRecords).where(eq(profileRecords.userId, userId))
    ).map(rowToRecord);

    const plan = reconcile(existing, parsed.records);

    // --- Apply: add + update automatically, flag removals for review ----------
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
          tags,
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
          tags,
          data: data as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(
          and(eq(profileRecords.id, id), eq(profileRecords.source, 'github-sync')),
        );
      await audit(userId, id, 'update', 'github-sync', { type });
    }

    for (const { id, reason } of plan.toFlag) {
      await db
        .update(profileRecords)
        .set({ flaggedForRemoval: true, updatedAt: new Date() })
        .where(
          and(eq(profileRecords.id, id), eq(profileRecords.source, 'github-sync')),
        );
      await audit(userId, id, 'flag-removed', 'github-sync', { reason });
    }

    // Roles referenced by parsed bullets.
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

    // Contact details discovered in the portfolio, only filling blanks.
    if (parsed.contact) {
      await db
        .insert(contactInfo)
        .values({
          userId,
          fullName: parsed.contact.fullName ?? '',
          email: parsed.contact.email ?? '',
          phone: parsed.contact.phone,
          location: parsed.contact.location,
          portfolioUrl: parsed.contact.portfolioUrl,
          githubUrl: parsed.contact.githubUrl,
          linkedinUrl: parsed.contact.linkedinUrl,
        })
        .onConflictDoNothing();
    }

    await db
      .update(users)
      .set({ lastSyncedSha: sha, lastSyncedAt: new Date() })
      .where(eq(users.id, userId));

    const fresh = (
      await db.select().from(profileRecords).where(eq(profileRecords.userId, userId))
    ).map(rowToRecord);

    return { summary: summarizePlan(plan), records: fresh };
  };
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
