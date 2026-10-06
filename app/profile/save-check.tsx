'use client';

/**
 * What the steward says between Save and the database — STEWARD.md §3, "where it sits" 2.
 *
 * Shown only when there is something to say: a duplicate, a spelling that will be
 * normalised, or better wording. Each rewording is offered, never applied for the user,
 * and pressing Save again saves whatever the form now holds.
 */

import { useState } from 'react';
import type { SaveCheck } from '@/lib/server/steward';

export function SaveCheckPanel({
  check,
  onUse,
}: {
  check: SaveCheck;
  onUse: (field: string, value: string) => void;
}) {
  const [used, setUsed] = useState<Set<number>>(new Set());

  return (
    <div role="status" className="mt-3 border border-brand-tint bg-brand-tint/30 p-3">
      <p className="text-sm font-semibold">Before you save</p>
      {check.notes.length > 0 ? (
        <ul className="mt-1.5 space-y-1 text-sm">
          {check.notes.map((n, i) => (
            <li key={i} className="[overflow-wrap:anywhere]">
              {n}
            </li>
          ))}
        </ul>
      ) : null}
      {check.rewrites.map((r, i) => (
        <div key={i} className="mt-2.5">
          <p className="text-xs font-medium text-muted">Suggested wording</p>
          <p className="mt-1 bg-surface px-2.5 py-1.5 text-sm [overflow-wrap:anywhere]">{r.to}</p>
          <p className="mt-1 text-xs text-muted">{r.reason}</p>
          <button
            type="button"
            disabled={used.has(i)}
            onClick={() => {
              onUse(r.field, r.to);
              setUsed(new Set(used).add(i));
            }}
            className="mt-1.5 min-h-11 border border-brand px-3.5 text-sm font-semibold text-brand-dark hover:bg-brand-tint disabled:opacity-50"
          >
            {used.has(i) ? 'Using this' : 'Use this wording'}
          </button>
        </div>
      ))}
      <p className="mt-2.5 text-xs text-muted">Press Save to keep what the form holds now.</p>
    </div>
  );
}
