import Link from 'next/link';
import { requireApprovedUser } from '@/lib/server/approval';
import { AppHeader } from '@/components/app-header';
import { getActivity } from '@/lib/server/activity';
import { effectiveRunStatus } from '@/lib/server/draft-run';

export const metadata = { title: 'Activity' };
export const dynamic = 'force-dynamic';

/**
 * Times print in UTC and say so. This is a server component with no idea of the reader's
 * zone, and a local-looking time that is silently five and a half hours off is worse than
 * one that names its zone.
 */
const when = (d: Date) =>
  `${d.toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} UTC`;

const STATUS: Record<ReturnType<typeof effectiveRunStatus>, { label: string; tone: string }> = {
  success: { label: 'Finished', tone: 'bg-success-tint text-success' },
  failed: { label: 'Failed', tone: 'bg-danger-tint text-danger' },
  killed: { label: 'Timed out', tone: 'bg-danger-tint text-danger' },
  running: { label: 'Running', tone: 'bg-warning-tint text-warning' },
};

const HALT_WORDS: Record<string, string> = {
  'iteration-cap': 'stopped after its attempts',
  'budget-cap': 'paused for the time limit',
  'unfixable-gap': 'profile lacks what the job asks',
  'no-progress': 'revisions stopped helping',
};

export default async function ActivityPage() {
  const session = await requireApprovedUser();

  const { runs, summary, usage, dailyLimit, changes } = await getActivity(session.user.id);
  // The stored error detail is for the operator (lib/db/schema.ts says so): it can carry a
  // provider's or the database's own words. Everyone else sees what kind of failure it was.
  const operator = Boolean(
    process.env.ALERT_EMAIL && session.user.email?.toLowerCase() === process.env.ALERT_EMAIL.trim().toLowerCase(),
  );
  const today = usage[0];

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/activity" width="6xl" />

      <main className="mx-auto max-w-6xl px-5 py-8">
        <h1 className="font-display text-3xl">Activity</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Every draft attempt — including the ones that failed — what the AI calls cost, and
          what changed in your profile. Nothing here is shared; it is your own record.
        </p>

        <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Recent draft attempts" value={String(summary.total)} />
          <Stat
            label="Succeeded"
            value={summary.successPct === null ? '—' : `${summary.successPct}%`}
          />
          <Stat label="Failed" value={String(summary.failed)} danger={summary.failed > 0} />
          <Stat
            label="AI calls today"
            value={`${today.calls} / ${dailyLimit.maxCalls}`}
          />
        </dl>

        <section className="mt-10" aria-labelledby="runs-heading">
          <h2 id="runs-heading" className="font-display text-2xl">Draft runs</h2>
          {runs.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              No drafts yet. <Link href="/" className="font-semibold underline">Draft a resume</Link>{' '}
              and each attempt is recorded here.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {runs.map((r) => {
                const status = effectiveRunStatus(r);
                return (
                <li key={r.id} className="rounded-xl border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0">
                      <p className="font-semibold [overflow-wrap:anywhere]">
                        {r.roleTitle || 'Job not understood'}
                        {r.company ? <span className="font-normal text-muted"> · {r.company}</span> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {when(r.startedAt)} · {Math.round(r.durationMs / 1000)}s · {r.budgetCalls} AI calls
                        {r.haltReason ? ` · ${HALT_WORDS[r.haltReason] ?? r.haltReason}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {r.score != null ? (
                        <span
                          className={`font-mono text-lg font-semibold tabular ${r.score >= 8.5 ? 'text-success' : 'text-warning'}`}
                        >
                          {r.score.toFixed(1)}
                        </span>
                      ) : null}
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS[status].tone}`}>
                        {STATUS[status].label}
                      </span>
                    </div>
                  </div>

                  {status === 'failed' || status === 'killed' ? (
                    <p className="mt-2 rounded-lg bg-danger-tint px-3 py-2 font-mono text-xs text-danger [overflow-wrap:anywhere]">
                      {status === 'killed'
                        ? 'Stopped at the time limit before it could finish.'
                        : `${r.errorKind ?? 'unknown'}${operator && r.errorDetail ? ` — ${r.errorDetail}` : ''}`}
                    </p>
                  ) : null}

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    {r.snapshotId ? (
                      <Link
                        href={`/resume/${r.snapshotId}`}
                        className="inline-flex min-h-11 items-center font-semibold text-brand-dark hover:underline"
                      >
                        Open resume
                      </Link>
                    ) : null}
                    {r.stages.length > 0 ? (
                      <details className="group">
                        <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-brand-dark">
                          Stage timeline
                        </summary>
                        <ol className="mb-2 space-y-1 font-mono text-muted">
                          {r.stages.map((s, i) => (
                            <li key={i} className="[overflow-wrap:anywhere]">
                              <span className="tabular">{(s.elapsedMs / 1000).toFixed(1)}s</span>{' '}
                              <span className={s.status === 'error' ? 'text-danger' : ''}>
                                {s.stage} {s.status}
                              </span>{' '}
                              — {s.message}
                            </li>
                          ))}
                        </ol>
                      </details>
                    ) : null}
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="mt-10 grid gap-10 lg:grid-cols-2">
          <section aria-labelledby="usage-heading">
            <h2 id="usage-heading" className="font-display text-2xl">AI usage</h2>
            <p className="mt-1 text-sm text-muted">
              Last {usage.length} days (UTC). The daily allowance is {dailyLimit.maxCalls} calls
              and {(dailyLimit.maxTokens / 1_000_000).toFixed(0)}M tokens.
            </p>
            <ul className="mt-4 space-y-2">
              {usage.map((u) => (
                <li key={u.day} className="grid grid-cols-[2.5rem_1fr_9.5rem] items-center gap-3 text-xs">
                  <span className="font-mono text-muted">{u.day.slice(5)}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-line" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-brand"
                      style={{ width: `${Math.min(100, (u.calls / dailyLimit.maxCalls) * 100)}%` }}
                    />
                  </span>
                  <span className="text-right font-mono tabular">
                    {u.calls} calls · {(u.tokens / 1000).toFixed(0)}k tokens
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="changes-heading">
            <h2 id="changes-heading" className="font-display text-2xl">Profile changes</h2>
            <p className="mt-1 text-sm text-muted">
              {changes.length ? `The newest ${changes.length} changes to your profile.` : 'No profile changes recorded yet.'}
            </p>
            {changes.length > 0 && (
            <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-surface">
              {changes.map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-3 px-4 py-2.5 text-sm">
                  <span>
                    <span className="font-semibold capitalize">{c.action.replace(/-/g, ' ')}</span>{' '}
                    <span className="text-muted">
                      {String((c.diff as { type?: string } | null)?.type ?? 'record').replace(/-/g, ' ')}
                    </span>
                  </span>
                  <span className="text-xs text-muted">
                    {SOURCE_WORDS[c.source] ?? c.source} · {when(c.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

const SOURCE_WORDS: Record<string, string> = {
  manual: 'by you',
  'github-sync': 'from your portfolio',
  'ai-import': 'from an import',
};

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className={`mt-1.5 font-mono text-2xl font-semibold tabular ${danger ? 'text-danger' : ''}`}>{value}</dd>
    </div>
  );
}
