'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Timeline } from './timeline';
import { GateQueries, INTEL_MAX_CREDITS } from './gate-queries';
import { ResultRow } from './result-row';
import { MarketCard } from './market-card';
import { CreditMeter } from './credit-meter';
import { Chip, SampleChip } from './chip';
import { useRadar } from './use-radar';

export function RunView({
  demo,
  publicDemo = false,
  hasProfile,
}: {
  demo: boolean;
  /** Signed-out sample page: no tailoring, no credit lookups, no real apply links. */
  publicDemo?: boolean;
  hasProfile: boolean;
}) {
  const router = useRouter();
  const r = useRadar(demo);
  const [intel, setIntel] = useState(false);
  const [needProfile, setNeedProfile] = useState(false);
  const { run } = r;

  async function tailor(key: string) {
    setNeedProfile(false);
    const out = await r.select(key);
    if (!out) return;
    if (!hasProfile) {
      setNeedProfile(true);
      return;
    }
    const p = out.state.postings.find((x) => x.key === key);
    try {
      sessionStorage.setItem('radar:jobText', out.jobText);
      sessionStorage.setItem('radar:jobLabel', p ? `${p.title} at ${p.company}` : 'Job Radar pick');
    } catch {
      /* storage blocked: the draft page just opens empty */
    }
    router.push('/');
  }

  if (!r.ready) return <Skeleton label="Checking for a run in progress" />;

  const active = run && (run.status === 'running' || run.status === 'awaiting');
  const failed = run && (run.status === 'error' || run.status === 'cancelled');

  return (
    <div className="mt-8">
      {demo && (
        <p className="mb-4 border border-dashed border-rule p-3 text-sm">
          <SampleChip />{' '}
          <span className="ml-1">
            {publicDemo
              ? 'Sample data — a scripted demo. No live search is running.'
              : 'Demo mode: a scripted run with invented postings. Nothing is searched or spent.'}
          </span>
        </p>
      )}
      <div className="mb-6 border-y border-line py-3">
        <CreditMeter credits={r.credits} used={run?.creditsUsed ?? 0} sample={demo} />
      </div>
      {needProfile && (
        <p role="status" className="mb-4 border border-warning bg-warning-tint p-3 text-sm">
          Add your profile first so the tailored resume has real facts to use.{' '}
          <Link href="/import" className="font-semibold underline">
            Import your resume
          </Link>
        </p>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {run ? `Step ${Math.min(run.step, run.totalSteps)} of ${run.totalSteps}: ${run.message}` : ''}
      </div>
      {r.notice && (
        <p role="status" className="mb-4 border border-warning bg-warning-tint p-3 text-sm">
          {r.notice}
        </p>
      )}
      {r.error && (
        <div role="alert" className="mb-4 border border-danger bg-danger-tint p-3 text-sm">
          <p>{r.error}</p>
          {run && run.status === 'running' && (
            <button type="button" className="btn mt-2" onClick={r.retry}>
              Try again
            </button>
          )}
        </div>
      )}

      {!run ? (
        <section className="sheet max-w-xl p-5" aria-labelledby="start-h">
          <p className="eyebrow">Start</p>
          <h2 id="start-h" tabIndex={-1} className="mt-1 font-display text-2xl outline-none">
            Search from your profile
          </h2>
          <p className="mt-1 text-sm text-muted">
            A planner drafts up to three searches from your resume. You approve them before anything is spent.
          </p>
          <label className="mt-4 flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 size-4 accent-brand" checked={intel} onChange={(e) => setIntel(e.target.checked)} />
            <span>
              Look up employer ratings and news
              <span className="block text-muted">Optional. Costs up to {INTEL_MAX_CREDITS} extra credits.</span>
            </span>
          </label>
          <button type="button" className="btn btn-primary mt-5" disabled={r.busy} onClick={() => r.start(intel)}>
            Start Job Radar
          </button>
        </section>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside aria-label="Run progress">
            <h2 id="run-h" tabIndex={-1} className="eyebrow mb-4 outline-none">
              Run · {run.mode === 'replay' ? 'sample data' : 'live'}
            </h2>
            <Timeline run={run} />
            <div className="mt-5 flex flex-wrap gap-3">
              {active && (
                <button
                  type="button"
                  className="btn"
                  disabled={r.busy}
                  onClick={() => {
                    // The Stop button unmounts: keep keyboard focus inside the run panel.
                    document.getElementById('run-h')?.focus();
                    void r.cancel();
                  }}
                >
                  {run.status === 'awaiting' ? 'Cancel run' : 'Stop'}
                </button>
              )}
              {(failed || run.status === 'done') && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    r.restart();
                    // The start panel renders on the next frame; move focus to it.
                    requestAnimationFrame(() => document.getElementById('start-h')?.focus());
                  }}
                >
                  {failed ? 'Restart' : 'New search'}
                </button>
              )}
            </div>
          </aside>

          <div className="min-w-0 space-y-8">
            {run.status === 'error' && (
              <p role="alert" className="border border-danger bg-danger-tint p-3 text-sm">
                The run stopped: {run.error || 'something went wrong.'} No further credits are being spent.
              </p>
            )}
            {run.status === 'cancelled' && (
              <p className="border border-rule p-3 text-sm">You stopped this run. Anything already found is shown below.</p>
            )}

            {run.status === 'awaiting' && run.gate === 'queries' && (
              <GateQueries
                key={run.runId}
                initial={run.state.queries.length ? run.state.queries : (run.state.plan?.queries ?? [])}
                intelOn={run.state.intelOn}
                busy={r.busy}
                onApprove={r.approve}
              />
            )}

            {run.state.ranked.length > 0 ? (
              <section aria-labelledby="results-h">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="results-h" className="font-display text-2xl">
                    {run.gate === 'select' ? 'Pick one to tailor your resume for' : 'Ranked openings'}
                  </h2>
                  <span className="flex items-center gap-2">
                    {run.mode === 'replay' && <SampleChip />}
                    <Chip>{run.state.ranked.length} ranked</Chip>
                  </span>
                </div>
                <ol className="mt-5 list-none p-0">
                  {run.state.ranked.map((rk) => {
                    const p = run.state.postings.find((x) => x.key === rk.key);
                    if (!p) return null;
                    return (
                      <ResultRow
                        key={rk.key}
                        posting={p}
                        rank={rk}
                        intel={run.state.intel.find((i) => i.company.toLowerCase() === p.company.toLowerCase())}
                        canSelect={run.gate === 'select' && run.status === 'awaiting'}
                        busy={r.busy}
                        chosen={run.state.selectedKey === rk.key}
                        onSelect={() => tailor(rk.key)}
                        sample={demo}
                        signInToTailor={publicDemo}
                      />
                    );
                  })}
                </ol>
              </section>
            ) : run.status === 'done' ? (
              <div className="border-t border-line pt-6">
                <p className="font-display text-xl">No openings matched</p>
                <p className="mt-2 max-w-md text-sm text-muted">
                  The searches returned nothing usable. Start again and edit the searches at the first gate.
                </p>
              </div>
            ) : (
              active && run.gate !== 'queries' && <ResultsSkeleton />
            )}

            {run.state.market && <MarketCard market={run.state.market} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div aria-hidden="true" className="border-t border-line">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border-b border-line py-5">
          <div className="h-5 w-1/2 bg-line" />
          <div className="mt-3 h-3 w-2/3 bg-line" />
          <div className="mt-3 h-3 w-1/3 bg-line" />
        </div>
      ))}
    </div>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <div className="mt-8" aria-busy="true">
      <p role="status" className="sr-only">
        {label}
      </p>
      <ResultsSkeleton />
    </div>
  );
}
