/**
 * Emailing the operator when drafts fail — the alert path for `draft_run`.
 *
 * The runs have been recorded since draft-run.ts existed, but a failure still reached
 * nobody: the owner found out only by drafting and watching it break. An hourly scheduled
 * job (netlify/functions/draft-alerts.mts) now reads the previous clock hour's failures
 * and, if there were any, sends one email summarising them.
 *
 * Clock-hour windows rather than "since the last check": the window is a pure function of
 * the time, so no state has to be stored and two overlapping runs cannot double-alert.
 * ponytail: a scheduler run that never fires loses that hour's alert; add a stored
 * high-water mark if missed hours start to matter.
 */

import 'server-only';
import { and, eq, gte, lt, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { draftRuns } from '@/lib/db/schema';
import { appUrl, isMailConfigured, sendOperatorEmail } from '@/lib/auth/mail';
import { KILLED_AFTER_MS } from './draft-run';

/** The clock hour before `now`, in UTC: [start, end). */
export function previousHour(now: Date): { start: Date; end: Date } {
  const end = new Date(now);
  end.setUTCMinutes(0, 0, 0);
  return { start: new Date(end.getTime() - 3_600_000), end };
}

export interface FailedRun {
  finishedAt: Date;
  errorKind: string | null;
  errorDetail: string | null;
  roleTitle: string;
  company: string;
}

/** Subject and body for a batch of failures, or null when there is nothing to say. */
export function composeAlert(
  failures: FailedRun[],
  window: { start: Date; end: Date },
): { subject: string; text: string } | null {
  if (failures.length === 0) return null;

  const byKind = new Map<string, number>();
  for (const f of failures) byKind.set(f.errorKind ?? 'unknown', (byKind.get(f.errorKind ?? 'unknown') ?? 0) + 1);
  const hour = (d: Date) => d.toISOString().slice(11, 16);

  const text = [
    `${failures.length} resume draft${failures.length === 1 ? '' : 's'} failed between ${hour(window.start)} and ${hour(window.end)} UTC on ${window.start.toISOString().slice(0, 10)}.`,
    '',
    'By cause:',
    ...[...byKind].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `  ${n} × ${kind}`),
    '',
    'Each failure:',
    ...failures.map((f) =>
      [
        `  ${hour(f.finishedAt)} UTC — ${f.errorKind ?? 'unknown'}${f.roleTitle ? ` — ${f.roleTitle}${f.company ? ` at ${f.company}` : ''}` : ''}`,
        f.errorDetail ? `    ${f.errorDetail.slice(0, 300)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '',
    `Run history: ${appUrl('/activity')}`,
  ].join('\n');

  return {
    subject: `Resumer AI: ${failures.length} draft${failures.length === 1 ? '' : 's'} failed in the last hour`,
    text,
  };
}

export interface AlertOutcome {
  window: { start: string; end: string };
  failures: number;
  sent: boolean;
  /** Why nothing was sent, when nothing was. */
  reason?: string;
}

export async function runDraftAlerts(now = new Date(), opts: { dryRun?: boolean } = {}): Promise<AlertOutcome> {
  const window = previousHour(now);
  const rows = await db
    .select({
      status: draftRuns.status,
      finishedAt: draftRuns.finishedAt,
      errorKind: draftRuns.errorKind,
      errorDetail: draftRuns.errorDetail,
      roleTitle: draftRuns.roleTitle,
      company: draftRuns.company,
    })
    .from(draftRuns)
    .where(
      or(
        and(eq(draftRuns.status, 'failed'), gte(draftRuns.finishedAt, window.start), lt(draftRuns.finishedAt, window.end)),
        // Killed at the time limit: opened in this hour and never completed. A running row
        // keeps finishedAt equal to startedAt, so the same window applies.
        and(
          eq(draftRuns.status, 'running'),
          gte(draftRuns.finishedAt, window.start),
          lt(draftRuns.finishedAt, window.end),
          lt(draftRuns.finishedAt, new Date(now.getTime() - KILLED_AFTER_MS)),
        ),
      ),
    )
    .orderBy(draftRuns.finishedAt);
  const failures: FailedRun[] = rows.map(({ status, ...run }) =>
    status === 'running'
      ? { ...run, errorKind: 'killed-at-time-limit', errorDetail: 'The function stopped before it could record an outcome.' }
      : run,
  );

  const base = {
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    failures: failures.length,
  };
  const alert = composeAlert(failures, window);
  if (!alert) return { ...base, sent: false, reason: 'no failures' };

  const to = process.env.ALERT_EMAIL?.trim();
  if (!to) return { ...base, sent: false, reason: 'ALERT_EMAIL is not set' };
  if (!isMailConfigured()) return { ...base, sent: false, reason: 'no mail provider configured' };
  if (opts.dryRun) return { ...base, sent: false, reason: 'dry run' };

  const result = await sendOperatorEmail(to, alert.subject, alert.text);
  if (!result.ok) console.error('[draft-alerts] could not send:', result.error);
  return { ...base, sent: result.ok, ...(result.ok ? {} : { reason: result.error }) };
}
