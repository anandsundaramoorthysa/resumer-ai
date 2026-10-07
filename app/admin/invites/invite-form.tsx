'use client';

import { useState, useTransition } from 'react';
import { createInviteAction, setInviteDisabledAction, type CreateInviteResult } from './actions';

export function CreateInviteForm() {
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [expiresOn, setExpiresOn] = useState('');
  const [result, setResult] = useState<CreateInviteResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="mt-3 grid max-w-md gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setResult(null);
        start(async () =>
          setResult(
            await createInviteAction({ label, maxUses, expiresOn }).catch(() => ({ ok: false, message: 'That did not go through.' })),
          ),
        );
      }}
    >
      <label className="block">
        <span className="text-xs font-medium text-muted">Label (who or what it is for)</span>
        <input className="field mt-1" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-muted">Max uses</span>
        <input className="field mt-1" type="number" min={1} max={10000} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} required />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-muted">Expires (optional, end of that day IST)</span>
        <input className="field mt-1" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
      </label>
      <button type="submit" disabled={pending} className="btn btn-primary w-fit">
        {pending ? 'Creating…' : 'Create code'}
      </button>
      {result ? (
        <div role={result.ok ? 'status' : 'alert'} className={`text-sm ${result.ok ? '' : 'text-danger'}`}>
          <p>{result.message}</p>
          {result.code ? (
            <p className="mt-2 border border-rule p-3 font-mono text-lg tracking-wider select-all">{result.code}</p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

export function DisableButton({ id, disabled }: { id: string; disabled: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => void (await setInviteDisabledAction(id, !disabled)))}
      className="btn text-xs"
    >
      {disabled ? 'Enable' : 'Disable'}
    </button>
  );
}
