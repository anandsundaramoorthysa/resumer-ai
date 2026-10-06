'use client';

import { useEffect, useState } from 'react';
import type { RadarEvent, RadarStatus } from '@/lib/radar/events';
import { Chip, SampleChip } from './chip';

const AGENTS = [
  { id: 'plan', name: 'Planner' },
  { id: 'search', name: 'Searcher' },
  { id: 'rank', name: 'Ranker + Market Signal' },
  { id: 'intel', name: 'Employer Intel' },
] as const;

const kind = (phase: string) => phase;

/**
 * Index of the agent doing (or next to do) the work; AGENTS.length when all are done.
 * Every phase is listed: an unknown one is -1, which marks nothing as done or current.
 */
const PHASE_AGENT: Record<string, number> = {
  plan: 0,
  'awaiting-queries': 1,
  search: 1,
  rank: 2,
  intel: 3,
  select: AGENTS.length,
  done: AGENTS.length,
};
const current = (phase: string): number => PHASE_AGENT[phase] ?? -1;

type RowState = 'done' | 'running' | 'pending' | 'failed' | 'skipped';
const STATE_WORD: Record<RowState, string> = { done: 'Done', running: 'Running', pending: 'Waiting', failed: 'Stopped', skipped: 'Skipped' };

export function Timeline({ run }: { run: RadarStatus }) {
  const live = run.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const cur = current(run.phase);
  const byAgent = AGENTS.map((a) => run.events.filter((e) => kind(e.phase) === a.id));
  const firstAt = (ev: RadarEvent[]) => (ev.length ? Date.parse(ev[0].at) : NaN);

  return (
    <ol className="relative m-0 list-none p-0">
      <span aria-hidden className="absolute bottom-3 left-[9px] top-3 w-px bg-rule" />
      {AGENTS.map((a, i) => {
        const ev = byAgent[i];
        const skipped = a.id === 'intel' && !run.state.intelOn && cur > i;
        let state: RowState = skipped ? 'skipped' : i < cur ? 'done' : 'pending';
        if (i === cur) {
          if (run.status === 'running') state = 'running';
          else if (run.status === 'error' || run.status === 'cancelled') state = 'failed';
        }
        const last = ev[ev.length - 1];
        const message = skipped
          ? 'Off for this run'
          : i === cur && run.status !== 'done'
            ? run.status === 'awaiting' && run.gate === 'queries'
              ? 'Waiting for you to approve the searches'
              : run.message
            : last?.message ?? 'Not started';
        const start = firstAt(ev);
        const end = i === cur && live ? now : firstAt(byAgent.slice(i + 1).find((x) => x.length) ?? []) || (last ? Date.parse(last.at) : NaN);
        const secs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : null;
        const source = [...ev].reverse().find((e) => e.source)?.source;
        const isCur = i === cur && run.status !== 'done';
        return (
          <li key={a.id} aria-current={isCur ? 'step' : undefined} className="relative flex gap-3 pb-5 last:pb-0">
            <span
              aria-hidden
              className={`relative z-10 mt-1 grid size-[19px] shrink-0 place-items-center border-2 ${
                state === 'running'
                  ? 'border-brand bg-brand motion-safe:animate-pulse'
                  : state === 'done' || state === 'skipped'
                    ? 'border-ink bg-ink text-paper'
                    : state === 'failed'
                      ? 'border-danger bg-paper text-danger'
                      : 'border-rule bg-paper'
              }`}
            >
              {state === 'done' && (
                <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 6.5 5 9.5 10 3" />
                </svg>
              )}
              {state === 'failed' && <span className="font-mono text-xs font-bold leading-none">!</span>}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-display text-base">{a.name}</span>
                <span className="font-mono text-xs uppercase tracking-wider text-muted">{STATE_WORD[state]}</span>
                {secs !== null && <span className="font-mono text-xs tabular-nums text-muted">{secs}s</span>}
              </div>
              <p className="mt-0.5 text-sm text-muted">{message}</p>
              {source && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Chip>{source}</Chip>
                  {run.mode === 'replay' && <SampleChip />}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
