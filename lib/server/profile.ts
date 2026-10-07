/**
 * Server-side profile access — the boundary between the database and the engine.
 *
 * Every query is scoped by userId (NFR-6 / REQ-7.3), including while the app has a
 * single user, so opening this up later is a policy change rather than a migration.
 */

import 'server-only';
import { tidyRecordData } from '@/lib/steward/tidy';
import { and, desc, eq, ne } from 'drizzle-orm';
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
  ReviewState,
  RoleRecord,
} from '@/lib/types';
import type { PipelineOutput } from '@/lib/pipeline/run';
import type { FitReport } from '@/lib/fit/agent';
import type {
  QualityGateResult as GateResult,
  ResumeDocument as SnapshotDocument,
} from '@/lib/types';
import { latestCommitSha, parseRepoRef } from '@/lib/sync/github';
import { sameJob, splitMergedTitles, type RoleLike } from '@/lib/sync/roles';
import { educationIdentity } from '@/lib/sync/education';
import type { ParseResult } from '@/lib/sync/parse';
import type { ParsedRecord } from '@/lib/sync/reconcile';
import { hashContent, reconcile, summarizePlan } from '@/lib/sync/reconcile';
import { flagMissingRows, unflagSeen } from '@/lib/sync/guards';
import { loadDismissals } from '@/lib/server/dismissals';
import { getRepoAccess } from '@/lib/server/repo-access';

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
    reviewState: row.reviewState as ReviewState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    type: row.type,
    ...(row.data as Record<string, unknown>),
  } as ProfileRecord;
}

/**
 * The profile as the engine sees it.
 *
 * The `review_state = 'approved'` filter is the whole of the sync-injection defence,
 * so it lives here rather than in each caller: this is the one function the pipeline,
 * the retriever, the grounding check and the vocabulary check all read through. A
 * record a sync proposed but the user has not accepted does not exist to any of them,
 * which is what makes those checks mean something again — they are measuring against
 * facts a human vouched for rather than against whatever the last commit said.
 */
export async function loadProfileForUser(userId: string): Promise<LoadedProfile> {
  // Independent reads, issued together: one round trip instead of three.
  const [[contactRow], recordRows, roleRows] = await Promise.all([
    db.select().from(contactInfo).where(eq(contactInfo.userId, userId)).limit(1),
    db
      .select()
      .from(profileRecords)
      .where(and(eq(profileRecords.userId, userId), eq(profileRecords.reviewState, 'approved'))),
    db
      .select()
      .from(rolesTable)
      .where(and(eq(rolesTable.userId, userId), eq(rolesTable.reviewState, 'approved')))
      .orderBy(desc(rolesTable.startDate)),
  ]);

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
      reviewState: r.reviewState as ReviewState,
    })),
  };
}

/* ------------------------------------------------------------------ sync ---- */

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
    // Through getRepoAccess, like the sync itself. This read the OAuth token alone, which
    // since the GitHub App cannot see a private repository: every fit check for an App user
    // either 404'd on the SHA or said GitHub was not connected while the sync worked fine.
    const access = ref ? await getRepoAccess(userId, { owner: ref.owner, name: ref.repo }) : null;
    if (!ref || !access) {
      return { summary: 'GitHub not connected — using your saved profile.' };
    }

    const sha = await latestCommitSha(ref, access.token);
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
 * propose new claims for review, update approved ones automatically, flag
 * disappearances, never touch a manual record (REQ-2.4).
 *
 * "Propose" is the part that changed. Everything this function inserts arrives from an
 * LLM that read a git repository, and a repository can say anything; the rule and the
 * reasoning are in lib/sync/reconcile.ts. Nothing inserted here is part of the profile
 * until the user approves it on /profile — `loadProfileForUser` will not return it and
 * no draft can see it.
 */
export async function applyParsedProfile(
  userId: string,
  parsed: ParseResult,
  sha: string | null,
  /**
   * What the pass is allowed to conclude. The defaults are the old behaviour for a
   * complete pass; the stepped sync turns them off when any part of the repository went
   * unread (lib/sync/partial.ts), because absence from a partial parse is not removal and
   * a partial pass must not be remembered as the commit being done.
   */
  opts: { flagMissing?: boolean; storeSha?: boolean } = {},
): Promise<string> {
  // Roles first. The parser can only refer to a role by its content hash, but
  // lib/generate/assemble.ts groups bullets by real role id — so the hashes have to be
  // exchanged for row ids before any bullet is written, or every bullet lands in the
  // orphan bucket and the experience section comes out empty.
  const { idByHash: roleIdByHash, rejectedRoleIds } = await syncRoles(userId, parsed.roles);
  const records = parsed.records
    .map((rec) => {
      const bullet = rec as unknown as { type: string; roleId?: string };
      if (bullet.type !== 'experience-bullet' || !bullet.roleId) return rec;
      const roleId = roleIdByHash.get(bullet.roleId);
      return roleId ? ({ ...rec, roleId } as ParsedRecord) : rec;
    })
    // A bullet belonging to a job the user rejected is that job's claim in another
    // form, so it does not go back in the queue either. Without this, rejecting the
    // invented employer still left its invented achievements to be approved one by one.
    .filter((rec) => {
      const bullet = rec as unknown as { type: string; roleId?: string };
      if (bullet.type !== 'experience-bullet' || !bullet.roleId) return true;
      return !rejectedRoleIds.has(bullet.roleId);
    });

  const existing = (
    await db.select().from(profileRecords).where(eq(profileRecords.userId, userId))
  ).map(rowToRecord);

  // What the user has thrown away is not proposed again, whoever proposed it first.
  const plan = reconcile(existing, records, await loadDismissals(userId), {
    flagMissing: opts.flagMissing !== false,
  });

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
  plan.toInsert = dropResurrectedEducation(dedupeByHash(plan.toInsert), existing);

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
      diff: { type, reviewState: 'pending' },
    });
    return {
      userId,
      type,
      source: 'github-sync',
      contentHash,
      tags: tags ?? [],
      // Layer-1 tidying (lib/steward/tidy.ts). The hash stays the parser's, so a later
      // sync still recognises the fact it proposed.
      data: tidyRecordData(type, data),
      reviewState: 'pending',
    };
  });

  for (const chunk of chunked(inserts, 100)) {
    await db.insert(profileRecords).values(chunk).onConflictDoNothing();
  }

  // An update may not move a record onto a hash another row already holds — a manual copy
  // reconcile never matches against, or a fact inserted just above. That was a unique
  // violation mid-write: inserts done, audits and the SHA not, and the next sync planned
  // the same update and failed the same way, for good. The fact is already stored, so the
  // update is simply not needed.
  const heldBy = new Map(existing.map((r) => [r.contentHash, r.id]));
  for (const rec of plan.toInsert) heldBy.set(rec.contentHash, 'new');
  const updates = plan.toUpdate.filter(({ id, parsed: rec }) => {
    const holder = heldBy.get(rec.contentHash);
    if (holder && holder !== id) return false;
    heldBy.set(rec.contentHash, id);
    return true;
  });

  // Updates each target one row by id, so they can't collapse into a single statement
  // — but they can go out concurrently instead of one round trip at a time.
  for (const chunk of chunked(updates, 20)) {
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
            data: tidyRecordData(type, data),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(profileRecords.id, id),
              eq(profileRecords.userId, userId),
              eq(profileRecords.source, 'github-sync'),
              // reconcile() never plans an update against a rejected row; this says so
              // in SQL as well, for the same reason the source check is here.
              ne(profileRecords.reviewState, 'rejected'),
            ),
          );
      }),
    );
  }

  // Flagging sets the same value on every row, so it really is one statement.
  // Found again: a flag says "not found", so finding the record lifts it. Without this a
  // record flagged once stayed out of every resume until the user clicked Keep.
  for (const chunk of chunked(plan.toUnflag, 200)) {
    const cleared = await unflagSeen(db, userId, chunk.map((u) => u.id));
    for (const id of cleared) {
      audits.push({
        userId,
        recordId: id,
        action: 'update',
        source: 'github-sync',
        diff: { unflagged: true, reason: 'Found again in your portfolio source.' },
      });
    }
  }

  for (const chunk of chunked(plan.toFlag, 200)) {
    await flagMissingRows(db, userId, chunk.map((f) => f.id));
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

  if (sha && opts.storeSha !== false) {
    await db
      .update(users)
      .set({ lastSyncedSha: sha, lastSyncedAt: new Date() })
      .where(eq(users.id, userId));
  }

  return summarizePlan({ ...plan, toUpdate: updates });
}

/**
 * Inserts roles that aren't already stored and returns contentHash -> row id for all
 * of them, new and existing.
 *
 * The `role` table has no unique constraint on contentHash, so the previous
 * `onConflictDoNothing()` was a no-op: every sync appended a fresh copy of every role.
 * De-duplication has to happen here, in code, against what is already stored.
 *
 * A role a sync has never seen before goes in `pending`, exactly like a record. "Senior
 * Platform Engineer, Stripe, 2019-2024" is the fabrication the whole review exists to
 * catch, and it is a role rather than a record: an unreviewed one would put a job on
 * the profile page and count toward the years of experience the summary claims, even
 * before a single bullet under it was approved.
 */
async function syncRoles(
  userId: string,
  roles: ParseResult['roles'],
): Promise<{ idByHash: Map<string, string>; rejectedRoleIds: Set<string> }> {
  const stored = await db
    .select({
      id: rolesTable.id,
      contentHash: rolesTable.contentHash,
      title: rolesTable.title,
      company: rolesTable.company,
      startDate: rolesTable.startDate,
      endDate: rolesTable.endDate,
      location: rolesTable.location,
      reviewState: rolesTable.reviewState,
    })
    .from(rolesTable)
    .where(eq(rolesTable.userId, userId));

  // Rejected roles stay in the matching maps below on purpose: that is what makes the
  // next sync recognise the job it already offered and skip it, rather than proposing
  // it again every time the repository is read.
  const rejectedRoleIds = new Set(
    stored.filter((r) => r.reviewState === 'rejected').map((r) => r.id),
  );

  const idByHash = new Map(stored.map((r) => [r.contentHash, r.id]));

  // Matching on content hash alone is what let 16 rows accumulate for 10 jobs: the same
  // company spelled two ways hashes two ways. An identity index alongside it means a
  // re-spelling updates the existing row instead of adding another.
  const storedLike = stored.map((r) => ({ id: r.id, role: r as RoleLike }));
  const matchStored = (candidate: RoleLike) => storedLike.find((s) => sameJob(s.role, candidate))?.id;

  const pending: ParseResult['roles'] = [];
  for (const role of roles) {
    if (idByHash.has(role.contentHash)) continue;

    // A merged title ("AI Intern / Full Stack Developer") is several jobs, and each
    // half usually already exists as a correct row.
    const titles = splitMergedTitles(role.title);
    let matchedAll = true;
    for (const title of titles) {
      const existingId = matchStored({ ...role, title });
      if (existingId) {
        // Same job, better-spelled: point this parse at the row already there.
        idByHash.set(role.contentHash, existingId);
      } else {
        matchedAll = false;
      }
    }
    if (matchedAll && titles.length > 0) continue;

    if (pending.some((r) => sameJob(r, role))) {
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
          reviewState: 'pending',
        })),
      )
      .returning({ id: rolesTable.id, contentHash: rolesTable.contentHash });
    for (const row of inserted) {
      idByHash.set(row.contentHash, row.id);
    }
  }

  return { idByHash, rejectedRoleIds };
}

/**
 * Drops repeats within one batch. `profile_record` is unique on (userId, contentHash),
 * and two slices of the same file can legitimately yield the same fact.
 */
/**
 * Last line of defence against a degree coming back a second time.
 *
 * `reconcile()` matches an education record against stored rows using its own loose key
 * (credential *level* plus the institution's leading words). That key is broad enough to
 * update the right row, but it is not the key the parser deduplicates on, so a spelling
 * it happens to treat as distinct would arrive here as a fresh insert and the profile
 * would grow a second copy of a degree it already holds — exactly how three M.Sc. rows
 * accumulated. Identity here is the same one lib/sync/education.ts uses, checked against
 * both the batch and what is already stored.
 *
 * Manual rows count as already-stored on purpose: they are the user's own, sync may
 * never touch them (see lib/profile/records.ts), so re-adding a synced twin of one is
 * the one outcome worse than skipping the insert.
 */
function dropResurrectedEducation(
  records: ParsedRecord[],
  existing: ProfileRecord[],
): ParsedRecord[] {
  const isEducation = (r: { type: string }) => r.type === 'education';
  const keyOf = (r: unknown) => {
    const e = r as { institution: string; credential: string; field?: string };
    return educationIdentity(e.institution, e.credential, e.field);
  };

  const taken = new Set(existing.filter(isEducation).map(keyOf));

  return records.filter((rec) => {
    if (!isEducation(rec as unknown as { type: string })) return true;
    const key = keyOf(rec);
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
}

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

/**
 * REQ-9.2 — freeze exactly what was produced, so the tracker can point at it.
 *
 * Takes only the four fields it actually stores rather than a whole `PipelineOutput`.
 * The baseline route (REQ-6.7) never runs the pipeline — no job, no gate, no loop — and
 * hand-builds this argument, so every field added to the pipeline's output used to
 * become a field the baseline had to fake with a value nothing would ever read.
 */
export async function persistDraft(
  userId: string,
  result: Pick<PipelineOutput, 'document' | 'score' | 'job' | 'files'> & {
    /** The fit verdict the draft was started under — kept beside the score it explains. */
    fit?: FitReport | null;
  },
): Promise<string> {
  // One transaction: a failed application insert must not leave an orphan snapshot.
  return db.transaction(async (tx) => {
  const [snapshot] = await tx
    .insert(resumeSnapshots)
    .values({
      userId,
      document: result.document as unknown as Record<string, unknown>,
      jobRequirement: (result.job ?? null) as unknown as Record<string, unknown> | null,
      score: result.score.overall,
      scoreDetail: {
        ...(result.score as unknown as Record<string, unknown>),
        ...(result.fit ? { fit: result.fit } : {}),
      },
      recordHashSnapshot: result.document.recordHashSnapshot,
      renderMode: result.document.renderMode,
      fileName: result.files.pdfName,
    })
    .returning();

  await tx.insert(applications).values({
    userId,
    resumeSnapshotId: snapshot.id,
    roleTitle: result.job?.roleTitle ?? 'Baseline resume',
    company: result.job?.company ?? '',
    category: result.job?.category ?? 'general',
    score: result.score.overall,
    status: 'draft',
  });

  return snapshot.id;
  });
}

/** The status of this snapshot's application once it has left draft, else null (REQ-9.2). */
export async function sentApplicationStatus(userId: string, snapshotId: string): Promise<string | null> {
  const [app] = await db
    .select({ status: applications.status })
    .from(applications)
    .where(and(eq(applications.resumeSnapshotId, snapshotId), eq(applications.userId, userId)))
    .limit(1);
  return app && app.status !== 'draft' ? app.status : null;
}

/**
 * A saved resume, as an improvement pass needs it — or null when there is none to improve.
 *
 * Scoped by user, like every snapshot read (REQ-7.3). `applicationStatus` comes with it
 * because REQ-9.2 promises that downloading an application's resume gives "exactly what
 * was sent then": once the application has moved past `draft`, the snapshot is a record
 * of something sent, and improving it in place would quietly rewrite that record.
 */
export async function loadSnapshotForImprove(
  userId: string,
  snapshotId: string,
): Promise<{
  document: SnapshotDocument;
  result: GateResult;
  fit: FitReport | null;
  applicationStatus: string | null;
} | null> {
  const [row] = await db
    .select()
    .from(resumeSnapshots)
    .where(and(eq(resumeSnapshots.id, snapshotId), eq(resumeSnapshots.userId, userId)))
    .limit(1);
  if (!row) return null;

  const [app] = await db
    .select({ status: applications.status })
    .from(applications)
    .where(and(eq(applications.resumeSnapshotId, snapshotId), eq(applications.userId, userId)))
    .limit(1);

  const detail = (row.scoreDetail ?? {}) as unknown as GateResult & { fit?: FitReport };
  const { fit, ...result } = detail;

  return {
    document: row.document as unknown as SnapshotDocument,
    result: result as GateResult,
    fit: fit ?? null,
    applicationStatus: app?.status ?? null,
  };
}

/**
 * Writes an improvement pass back.
 *
 * With `document`, the pass produced a better version, and the snapshot, its score and the
 * tracker row's score all move to it. Without, only the loop state changes — the pass
 * found nothing better, and what it learned (which bullets cannot be strengthened, how
 * many passes have stalled) must still survive to the next request, or the next pass would
 * repeat this one.
 */
export async function saveImprovedSnapshot(
  userId: string,
  snapshotId: string,
  update: {
    result: GateResult;
    fit: FitReport | null;
    document?: SnapshotDocument;
    fileName?: string;
  },
): Promise<void> {
  const scoreDetail = {
    ...(update.result as unknown as Record<string, unknown>),
    ...(update.fit ? { fit: update.fit } : {}),
  };

  const scope = and(eq(resumeSnapshots.id, snapshotId), eq(resumeSnapshots.userId, userId));

  if (!update.document) {
    await db.update(resumeSnapshots).set({ scoreDetail }).where(scope);
    return;
  }

  await db
    .update(resumeSnapshots)
    .set({
      document: update.document as unknown as Record<string, unknown>,
      score: update.result.overall,
      scoreDetail,
      recordHashSnapshot: update.document.recordHashSnapshot,
      ...(update.fileName ? { fileName: update.fileName } : {}),
    })
    .where(scope);

  await db
    .update(applications)
    .set({ score: update.result.overall })
    .where(and(eq(applications.resumeSnapshotId, snapshotId), eq(applications.userId, userId)));
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
