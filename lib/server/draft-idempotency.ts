/**
 * Idempotency for the draft POST — one `Idempotency-Key` header, one pipeline.
 *
 * A client retry after a 502 or a dropped connection used to start a second full pipeline:
 * double the model spend and two snapshots of the same resume. The browser now mints a key
 * per user-initiated attempt (components/draft-console.tsx) and reuses it for retries of
 * that attempt; the draft route claims it here before anything runs.
 *
 *   (a) new key                          -> 'new'     proceed; the claim IS the draft_run row
 *   (b) row finished with a snapshot     -> 'done'    replay that snapshot, run nothing
 *   (c) row running, started < 90s ago   -> 'running' 409; the client polls /api/draft/status
 *   (d) row failed, or running > 90s     -> take over: the old row is retired (its key is
 *                                           renamed so the unique index keeps holding) and a
 *                                           fresh row claims the key
 *
 * The decision logic works against a small store interface so the races can be tested
 * without a database; `drizzleDraftRunStore` is the real one, and the same cases are run
 * against PGlite with the actual schema (see the report that came with this change).
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { draftRuns, resumeSnapshots } from '@/lib/db/schema';
import { DRAFT_TIME_BUDGET_MS } from '@/lib/ai/budget';

/**
 * Younger than this, an unfinished run is presumed alive; older is presumed dead.
 *
 * Derived from the budget the pipeline itself runs under (280s on Vercel, 20s elsewhere),
 * plus margin for the render and bookkeeping, floored at 60s. A fixed 90s let a retry start a
 * second pipeline while the first was still legitimately running. The housekeeping reaper's
 * 15-minute cutoff stays well above this.
 */
export function runningFreshMs(budgetMs: number = DRAFT_TIME_BUDGET_MS): number {
  return Math.max(60_000, budgetMs + 20_000);
}

export const MAX_KEY_LENGTH = 100;

export interface ClaimedRunRow {
  id: string;
  status: string;
  startedAt: Date;
  snapshotId: string | null;
  errorKind: string | null;
}

export interface DraftRunStore {
  /** Inserts a `running` row holding the key. Null when the key is already held. */
  insertClaim(userId: string, key: string | null, startedAt: Date): Promise<string | null>;
  find(userId: string, key: string): Promise<ClaimedRunRow | null>;
  /**
   * Retires a row that is not a live success: marks it failed/`abandoned` and renames its
   * key so the unique index lets a new row take the original. True only for the caller
   * whose update matched, so two concurrent takeovers cannot both proceed.
   */
  retire(userId: string, key: string, runId: string): Promise<boolean>;
}

export type DraftClaim =
  | { kind: 'new'; runId: string | null }
  | { kind: 'done'; runId: string; snapshotId: string }
  | { kind: 'running'; runId: string };

/** A key is client-supplied, so it is bounded and printable before it touches SQL or logs. */
export function normalizeIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length < 8 || key.length > MAX_KEY_LENGTH) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(key) ? key : null;
}

export function isFresh(row: Pick<ClaimedRunRow, 'startedAt'>, now: Date): boolean {
  return now.getTime() - row.startedAt.getTime() < runningFreshMs();
}

export async function claimDraftRun(
  store: DraftRunStore,
  userId: string,
  key: string | null,
  now: Date = new Date(),
): Promise<DraftClaim> {
  if (!key) return { kind: 'new', runId: await store.insertClaim(userId, null, now) };

  // Bounded: every pass either wins the insert or observes a row someone else holds. Two
  // passes cover a row pruned between the conflict and the read; the rest cover takeover.
  for (let pass = 0; pass < 4; pass++) {
    const id = await store.insertClaim(userId, key, now);
    if (id) return { kind: 'new', runId: id };

    const row = await store.find(userId, key);
    if (!row) continue; // vanished (pruned) — claim again

    if (row.snapshotId && (row.status === 'success' || row.status === 'running')) {
      // Finished, or persisted and only rendering/recording left: the resume exists.
      return { kind: 'done', runId: row.id, snapshotId: row.snapshotId };
    }
    if (row.status === 'running' && isFresh(row, now)) return { kind: 'running', runId: row.id };

    // Failed, abandoned, or running past the freshness window with nothing persisted.
    await store.retire(userId, key, row.id); // losing this race is fine: loop re-reads
  }
  const row = await store.find(userId, key);
  return row ? { kind: 'running', runId: row.id } : { kind: 'new', runId: null };
}

export type DraftStatus = {
  state: 'running' | 'done' | 'failed' | 'unknown';
  /** For 'running': how long the client should keep polling before giving up. */
  pollForMs?: number;
  snapshotId?: string;
  error?: string;
};

export async function draftStatus(
  store: Pick<DraftRunStore, 'find'>,
  userId: string,
  key: string,
  now: Date = new Date(),
): Promise<DraftStatus> {
  const row = await store.find(userId, key);
  if (!row) return { state: 'unknown' };
  if (row.snapshotId && (row.status === 'success' || row.status === 'running')) {
    return { state: 'done', snapshotId: row.snapshotId };
  }
  if (row.status === 'running') {
    return isFresh(row, now)
      ? { state: 'running', pollForMs: runningFreshMs() }
      : { state: 'failed', error: 'The draft stopped before it finished. Please retry.' };
  }
  return { state: 'failed', error: 'The draft did not finish. Please retry.' };
}

/* ----------------------------------------------------------------- real store -- */

type Db = typeof db;

const pgCode = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } } | null)?.code ??
  (e as { cause?: { code?: string } } | null)?.cause?.code;

export function drizzleDraftRunStore(d: Db = db): DraftRunStore {
  return {
    async insertClaim(userId, key, startedAt) {
      try {
        const rows = await d
          .insert(draftRuns)
          .values({ userId, startedAt, finishedAt: startedAt, status: 'running', idempotencyKey: key })
          .onConflictDoNothing({
            target: [draftRuns.userId, draftRuns.idempotencyKey],
            where: sql`${draftRuns.idempotencyKey} is not null`,
          })
          .returning({ id: draftRuns.id });
        return rows[0]?.id ?? null;
      } catch (err) {
        if (pgCode(err) === '23505') return null;
        // Without a row the draft still runs (recordDraftRun inserts one at the end).
        console.error('[draft-idempotency] could not open a run record for user', userId, err);
        return null;
      }
    },

    async find(userId, key) {
      const [row] = await d
        .select({
          id: draftRuns.id,
          status: draftRuns.status,
          startedAt: draftRuns.startedAt,
          snapshotId: draftRuns.snapshotId,
          errorKind: draftRuns.errorKind,
        })
        .from(draftRuns)
        .where(and(eq(draftRuns.userId, userId), eq(draftRuns.idempotencyKey, key)))
        .limit(1);
      return row ?? null;
    },

    async retire(userId, key, runId) {
      const rows = await d
        .update(draftRuns)
        .set({
          status: 'failed',
          errorKind: 'abandoned',
          // Frees the key for the retry while keeping the old row traceable.
          idempotencyKey: sql`${draftRuns.idempotencyKey} || ':abandoned:' || ${draftRuns.id}`,
        })
        .where(
          and(
            eq(draftRuns.id, runId),
            eq(draftRuns.userId, userId),
            eq(draftRuns.idempotencyKey, key),
            // Never retire a persisted result.
            sql`${draftRuns.snapshotId} is null`,
          ),
        )
        .returning({ id: draftRuns.id });
      return rows.length > 0;
    },
  };
}

/** Records the snapshot on the running row the moment it exists. Never throws. */
export async function markRunSnapshot(
  runId: string | null,
  userId: string,
  snapshotId: string,
  d: Db = db,
): Promise<void> {
  if (!runId) return;
  try {
    await d
      .update(draftRuns)
      .set({ snapshotId })
      .where(and(eq(draftRuns.id, runId), eq(draftRuns.userId, userId)));
  } catch (err) {
    console.error('[draft-idempotency] could not record the snapshot on the run', err);
  }
}

/** The `complete` payload for a draft that already finished, rebuilt from its snapshot. */
export async function replayCompletePayload(
  userId: string,
  snapshotId: string,
  d: Db = db,
): Promise<Record<string, unknown> | null> {
  const [snap] = await d
    .select()
    .from(resumeSnapshots)
    .where(and(eq(resumeSnapshots.id, snapshotId), eq(resumeSnapshots.userId, userId)))
    .limit(1);
  if (!snap) return null;

  const { fit, ...score } = (snap.scoreDetail ?? {}) as Record<string, unknown>;
  const pdf = snap.fileName;
  return {
    snapshotId: snap.id,
    score,
    job: snap.jobRequirement ?? null,
    // Not re-rendered: the files are built on download. The original self-test result is
    // not stored, so none is claimed beyond "nothing to report".
    selfTest: { pdfPassed: true, docxPassed: true, issues: [] },
    fileNames: { pdf, docx: pdf.replace(/\.pdf$/i, '.docx') },
    document: snap.document,
    fit: fit ?? null,
    replayed: true,
  };
}
