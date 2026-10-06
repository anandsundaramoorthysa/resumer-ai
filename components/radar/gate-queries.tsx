'use client';

import { useId, useState } from 'react';
import type { Query } from './use-radar';

/** Rough per-run intel cost shown before the user commits; the server enforces the real cap. */
export const INTEL_MAX_CREDITS = 5;

/** Gate G1: edit the planned searches, then approve. */
export function GateQueries({
  initial,
  intelOn,
  busy,
  onApprove,
}: {
  initial: Query[];
  intelOn: boolean;
  busy: boolean;
  onApprove: (q: Query[]) => void;
}) {
  const id = useId();
  const [qs, setQs] = useState(initial.map((x) => x.q));
  const clean = qs.map((q) => q.trim()).filter(Boolean);
  const cost = clean.length + (intelOn ? INTEL_MAX_CREDITS : 0);

  return (
    <form
      className="sheet p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean.length) onApprove(clean.map((q) => ({ q, why: initial.find((x) => x.q === q)?.why ?? 'Edited by you' })));
      }}
    >
      <p className="eyebrow">Gate 1 · your call</p>
      <h2 className="mt-1 font-display text-2xl">Approve these searches</h2>
      <p className="mt-1 text-sm text-muted">
        The planner wrote them from your profile. Edit any line, or clear one to drop it. Each search costs one credit.
      </p>
      <div className="mt-4 space-y-4">
        {initial.map((x, i) => (
          <div key={i}>
            <label htmlFor={`${id}-${i}`} className="eyebrow block">
              Search {i + 1}
            </label>
            <input
              id={`${id}-${i}`}
              className="field mt-1"
              value={qs[i]}
              maxLength={120}
              onChange={(e) => setQs(qs.map((v, j) => (j === i ? e.target.value : v)))}
              aria-describedby={`${id}-${i}-why`}
            />
            <p id={`${id}-${i}-why`} className="mt-1 text-sm text-muted">
              Why: {x.why}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm">
        Employer Intel is <strong>{intelOn ? 'on' : 'off'}</strong> for this run (chosen at the start).
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button type="submit" className="btn btn-primary" disabled={busy || !clean.length}>
          Run these searches
        </button>
        <p className="font-mono text-xs">
          Will spend {clean.length} cr{intelOn ? ` + up to ${INTEL_MAX_CREDITS} cr intel` : ''} · at most {cost} cr
        </p>
      </div>
      {!clean.length && (
        <p role="alert" className="mt-2 text-sm text-danger">
          Keep at least one search.
        </p>
      )}
    </form>
  );
}
