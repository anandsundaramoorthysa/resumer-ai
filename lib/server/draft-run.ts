/**
 * Writing down what a draft did — the record behind `draft_run` in lib/db/schema.ts.
 *
 * Until this existed, a draft that succeeded left a resume and a draft that failed left
 * nothing but a counter and one `console.error` line in a function log. Six production
 * faults were diagnosed by hand off that log this week, because it was the only record
 * there was. This turns each attempt into a row: what it was drafting for, what it
 * scored, what it spent, and — for a failure — what went wrong.
 *
 * Everything here that decides anything is a pure function, so the decisions can be
 * pinned by tests without a database: which stages the timeline holds, what an error is
 * called, and what of it is safe to keep.
 */

import { and, desc, eq, notInArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { draftRuns } from '@/lib/db/schema';
import type { DraftRunTrace } from '@/lib/pipeline/run';
import type { PipelineEvent } from '@/lib/types';

/**
 * How many runs a user keeps.
 *
 * This is a free Postgres tier and a draft can be started as often as someone likes, so
 * the table is bounded rather than left to grow. Fifty is far more than anyone reads and
 * still small enough that a year of use costs nothing; the value of this record is in the
 * recent past, and a run from six months ago answers no question the newest fifty cannot.
 */
export const RUNS_KEPT_PER_USER = 50;

/** Longer than any message worth keeping, short enough that no row is a liability. */
export const MAX_ERROR_DETAIL_CHARS = 2_000;

export interface DraftRunStage {
  stage: string;
  status: string;
  message: string;
  /** Milliseconds from the start of the run, so the timeline reads as offsets. */
  elapsedMs: number;
}

/**
 * The stage timeline, from the events the route already relays to the browser.
 *
 * `detail` is deliberately dropped. It carries score read-outs and keyword lists that are
 * already columns of their own or reconstructible from the snapshot, and keeping it would
 * put a copy of the job's keywords in every row for no question it helps answer.
 */
export function stagesFromEvents(events: PipelineEvent[], startedAt: Date): DraftRunStage[] {
  const origin = startedAt.getTime();
  return events.map((e) => ({
    stage: e.stage,
    status: e.status,
    message: e.message,
    elapsedMs: Math.max(0, e.at - origin),
  }));
}

/**
 * A stable slug for what went wrong, so failures can be counted by cause.
 *
 * The class name rather than the message: messages carry job titles and file names and
 * would make every failure unique, which is the opposite of what counting needs.
 */
export function errorKindFor(error: unknown, given?: string): string | null {
  if (given) return given;
  if (error === undefined || error === null) return null;
  const name = error instanceof Error ? error.name : typeof error;
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/Error$/i, '')
    .replace(/-+$/, '')
    .toLowerCase() || 'unknown';
}

/**
 * What of an error is safe to store.
 *
 * Owner-visible, never streamed — app/api/draft/route.ts sends the user an authored
 * sentence and logs the rest, and this row is the "rest". That still does not make it a
 * safe place for credentials: lib/sync/github.ts puts whole response bodies into the
 * messages it throws, and a driver error can arrive carrying the connection string it
 * failed on. So anything shaped like a secret goes before the text is kept, and the rest
 * is truncated.
 */
export function redactErrorDetail(error: unknown, maxChars = MAX_ERROR_DETAIL_CHARS): string | null {
  if (error === undefined || error === null) return null;
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  const cleaned = raw
    // scheme://user:password@host — a Postgres URL is the one that actually turns up here
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***:***@')
    // key=, token=, secret=, password=, api_key=… in a query string, a log line, or —
    // the case that actually turns up, because lib/sync/github.ts throws whole response
    // bodies — a JSON key, where the name carries a closing quote before its colon.
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password|pwd)"?\s*[=:]\s*)("?)[^\s"&,;]+\2/gi, '$1$2***$2')
    // Authorization: Bearer <token>
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');

  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}… (truncated)` : cleaned;
}

/**
 * A run still marked `running` this long after it started was killed, not slow: every
 * route that writes one runs inside a 30-second function.
 */
export const KILLED_AFTER_MS = 2 * 60_000;

/**
 * What a stored status means now. A row is written as `running` when the stream starts
 * and completed in `finish` — and a function killed at the platform's time limit never
 * reaches `finish`, so its row stays `running`. That is the one failure that used to leave
 * no record at all, and the likeliest one in production.
 */
export function effectiveRunStatus(
  run: { status: string; startedAt: Date },
  now = new Date(),
): 'success' | 'failed' | 'running' | 'killed' {
  if (run.status !== 'running') return run.status === 'failed' ? 'failed' : 'success';
  return now.getTime() - run.startedAt.getTime() > KILLED_AFTER_MS ? 'killed' : 'running';
}

/**
 * Writes the `running` row a stream completes later. Returns its id, or null when it could
 * not be written — the draft goes ahead regardless, and `recordDraftRun` inserts instead.
 */
export async function startDraftRun(userId: string, startedAt: Date): Promise<string | null> {
  try {
    const [row] = await db
      .insert(draftRuns)
      .values({ userId, startedAt, finishedAt: startedAt, status: 'running' })
      .returning({ id: draftRuns.id });
    return row?.id ?? null;
  } catch (err) {
    console.error('[draft-run] could not open a run record for user', userId, err);
    return null;
  }
}

/** Removes a `running` row for an attempt that turned out not to be worth recording. */
export async function discardDraftRun(userId: string, runId: string | null): Promise<void> {
  if (!runId) return;
  await db.delete(draftRuns).where(and(eq(draftRuns.id, runId), eq(draftRuns.userId, userId)));
}

export interface RecordDraftRunInput {
  /** The row `startDraftRun` opened, completed in place; without one a row is inserted. */
  runId?: string | null;
  userId: string;
  startedAt: Date;
  finishedAt: Date;
  events: PipelineEvent[];
  trace: DraftRunTrace;
  /** The snapshot this run produced, or null when it produced none. */
  snapshotId: string | null;
  error?: unknown;
  /** Set for failures the route names itself, such as an empty profile. */
  errorKind?: string;
}

/**
 * Writes the run, then trims the user's history back to its bound.
 *
 * The caller wraps this and carries on if it throws — a draft must not fail because its
 * record could not be written — but the trim gets its own guard anyway, so a row that WAS
 * written is not reported as a failure because the tidying afterwards went wrong.
 */
export async function recordDraftRun(input: RecordDraftRunInput): Promise<void> {
  const { trace } = input;
  const failed = input.error !== undefined || Boolean(input.errorKind);

  const values = {
    userId: input.userId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    status: failed ? 'failed' : 'success',
    roleTitle: trace.job?.roleTitle ?? '',
    company: trace.job?.company ?? '',
    snapshotId: input.snapshotId,
    score: trace.score?.overall ?? null,
    keywordCoveragePct: trace.score?.keywordCoveragePct ?? null,
    haltReason: trace.score?.haltReason ?? null,
    stages: stagesFromEvents(input.events, input.startedAt),
    budgetCalls: trace.budget.calls,
    budgetTokens: trace.budget.tokens,
    rewriteAttempted: trace.rewrite.attempted,
    rewriteFallbacks: trace.rewrite.fallbacks,
    rewriteFallbackReason: trace.rewrite.reason,
    errorKind: errorKindFor(input.error, input.errorKind),
    errorDetail: redactErrorDetail(input.error),
  };
  if (input.runId) {
    await db
      .update(draftRuns)
      .set(values)
      .where(and(eq(draftRuns.id, input.runId), eq(draftRuns.userId, input.userId)));
  } else {
    await db.insert(draftRuns).values(values);
  }

  try {
    await pruneDraftRuns(input.userId);
  } catch (err) {
    console.error('[draft-run] could not trim run history for user', input.userId, err);
  }
}

/** Keeps the newest RUNS_KEPT_PER_USER runs for one user and deletes the rest. */
export async function pruneDraftRuns(userId: string): Promise<void> {
  const keep = await db
    .select({ id: draftRuns.id })
    .from(draftRuns)
    .where(eq(draftRuns.userId, userId))
    .orderBy(desc(draftRuns.startedAt))
    .limit(RUNS_KEPT_PER_USER);

  if (keep.length < RUNS_KEPT_PER_USER) return;

  await db.delete(draftRuns).where(
    and(
      eq(draftRuns.userId, userId),
      notInArray(
        draftRuns.id,
        keep.map((r) => r.id),
      ),
    ),
  );
}
