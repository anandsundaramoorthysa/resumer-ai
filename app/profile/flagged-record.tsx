'use client';

import { useTransition } from 'react';
import { keepRecord, removeRecord } from './actions';

export function FlaggedRecord({
  id,
  type,
  text,
}: {
  id: string;
  type: string;
  text: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3.5 py-2.5">
      <span className="min-w-0 text-sm">
        <span className="font-mono text-[11px] text-muted">{type}</span>
        <br />
        {text}
      </span>
      <span className="flex flex-none gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => keepRecord(id))}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold hover:bg-paper disabled:opacity-50"
        >
          Keep
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => removeRecord(id))}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger-tint disabled:opacity-50"
        >
          Remove
        </button>
      </span>
    </li>
  );
}
