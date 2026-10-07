'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { redeemInviteAction, type RedeemFormResult } from './actions';

export function InviteForm() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<RedeemFormResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="mt-3 max-w-sm"
      onSubmit={(e) => {
        e.preventDefault();
        setResult(null);
        start(async () => {
          const r = await redeemInviteAction(code).catch(() => ({ ok: false, message: 'That did not go through. Try again.' }));
          setResult(r);
          if (r.ok) router.refresh();
        });
      }}
    >
      <label className="block">
        <span className="text-xs font-medium text-muted">Invite code</span>
        <input
          className="field mt-1 font-mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
      </label>
      <button type="submit" disabled={pending || code.trim().length < 12} className="btn mt-3">
        {pending ? 'Checking…' : 'Use code'}
      </button>
      {result ? (
        <p role={result.ok ? 'status' : 'alert'} className={`mt-2 text-sm ${result.ok ? 'text-success' : 'text-danger'}`}>
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
