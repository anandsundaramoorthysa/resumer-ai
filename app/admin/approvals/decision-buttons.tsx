'use client';

import { useState, useTransition } from 'react';
import { decideAccountAction, type DecisionResult } from './actions';

/** Approve and Deny — or, for a decision already made, the button that reverses it. */
export function DecisionButtons({ userId, current }: { userId: string; current?: 'approved' | 'denied' }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<DecisionResult | null>(null);

  const act = (decision: 'approved' | 'denied') =>
    startTransition(async () =>
      setResult(await decideAccountAction(userId, decision).catch(() => ({ ok: false, message: 'That did not go through. Try again.' }))),
    );

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {current !== 'approved' ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('approved')}
            className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
          >
            {current === 'denied' ? 'Approve instead' : 'Approve'}
          </button>
        ) : null}
        {current !== 'denied' ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('denied')}
            className="min-h-11 rounded-lg border border-danger px-4 text-sm font-semibold text-danger hover:bg-danger-tint disabled:opacity-50"
          >
            {current === 'approved' ? 'Revoke' : 'Deny'}
          </button>
        ) : null}
      </div>
      {result ? (
        <p role="status" className={`text-xs ${result.ok ? 'text-success' : 'text-danger'}`}>
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
