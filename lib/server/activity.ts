/**
 * What the Activity page shows — the owner's own run history, AI spend and profile changes.
 *
 * All three were already being written (`draft_run`, `ai_usage_daily`, `audit_log`) and
 * none was visible anywhere in the app. A draft that failed at 2am was a row nobody would
 * ever read unless they opened a database console, which is the gap this closes.
 *
 * Scoped to the signed-in user on every query. `error_detail` is owner-visible by design
 * (lib/db/schema.ts) — it is redacted when written, and this page is the owner reading
 * their own runs, never a stream to anyone else.
 */

import 'server-only';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '@/lib/db';
import { aiUsageDaily, auditLog, draftRuns } from '@/lib/db/schema';
import { DAILY_BUDGET } from '@/lib/ai/budget';

export const RUNS_SHOWN = 25;
export const USAGE_DAYS_SHOWN = 14;
export const CHANGES_SHOWN = 30;

export interface RunSummary {
  total: number;
  failed: number;
  /** 0–100, or null with no runs. */
  successPct: number | null;
  medianSeconds: number | null;
}

/** Pure, so the arithmetic is pinned by tests rather than by a database. */
export function summarizeRuns(runs: Array<{ status: string; durationMs: number }>): RunSummary {
  // A run still `running` when this is read either is in progress or was killed; either
  // way it has not succeeded, and a killed run is the failure that matters most.
  const failed = runs.filter((r) => r.status !== 'success').length;
  const durations = runs.map((r) => r.durationMs).sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median =
    durations.length === 0
      ? null
      : durations.length % 2
        ? durations[mid]
        : (durations[mid - 1] + durations[mid]) / 2;
  return {
    total: runs.length,
    failed,
    successPct: runs.length ? Math.round(((runs.length - failed) / runs.length) * 100) : null,
    medianSeconds: median === null ? null : Math.round(median / 1000),
  };
}

/** The last `days` UTC days, newest first, with zero rows filled in — a gap is a quiet day. */
export function usageDays(
  rows: Array<{ day: string; calls: number; tokens: number }>,
  days: number,
  now = new Date(),
): Array<{ day: string; calls: number; tokens: number }> {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, calls: 0, tokens: 0 };
  });
}

export async function getActivity(userId: string) {
  const since = new Date(Date.now() - USAGE_DAYS_SHOWN * 86_400_000).toISOString().slice(0, 10);

  const [runs, usage, changes] = await Promise.all([
    db
      .select()
      .from(draftRuns)
      .where(eq(draftRuns.userId, userId))
      .orderBy(desc(draftRuns.startedAt))
      .limit(RUNS_SHOWN),
    db
      .select({ day: aiUsageDaily.day, calls: aiUsageDaily.calls, tokens: aiUsageDaily.tokens })
      .from(aiUsageDaily)
      .where(and(eq(aiUsageDaily.userId, userId), gte(aiUsageDaily.day, since))),
    db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, userId))
      .orderBy(desc(auditLog.createdAt))
      .limit(CHANGES_SHOWN),
  ]);

  return {
    runs,
    summary: summarizeRuns(runs),
    usage: usageDays(usage, USAGE_DAYS_SHOWN),
    dailyLimit: DAILY_BUDGET,
    changes,
  };
}
