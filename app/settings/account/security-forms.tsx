'use client';

import { useState, useTransition } from 'react';
import { checkPassword } from '@/lib/auth/password-rules';
import { PasswordInput } from '@/components/password-input';
import { changePasswordAction, signOutEverywhereAction, type SecurityResult } from './security-actions';

export function ChangePasswordForm({ email }: { email: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [result, setResult] = useState<SecurityResult | null>(null);
  const [pending, start] = useTransition();
  const strength = checkPassword(next, email);

  return (
    <form
      className="mt-3 max-w-sm"
      onSubmit={(e) => {
        e.preventDefault();
        setResult(null);
        // On success the action signs out and redirects; anything returned is a refusal.
        start(async () => setResult(await changePasswordAction(current, next).catch(() => null)));
      }}
    >
      <label className="block">
        <span className="text-xs font-medium text-muted">Current password</span>
        <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" className="field mt-1" />
      </label>
      <label className="mt-3 block">
        <span className="text-xs font-medium text-muted">New password</span>
        <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className="field mt-1" />
      </label>
      {next && !strength.ok ? (
        <ul className="mt-2 space-y-1">
          {strength.problems.map((p) => (
            <li key={p} className="text-xs text-warning">○ {p}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-xs text-muted">Changing it signs you out on every device, including this one.</p>
      <button type="submit" disabled={pending || !current || !strength.ok} className="btn mt-3 text-sm">
        {pending ? 'Changing…' : 'Change password'}
      </button>
      {result && !result.ok ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {result.message} {result.problems?.join(' ')}
        </p>
      ) : null}
    </form>
  );
}

export function SignOutEverywhere() {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => void (await signOutEverywhereAction().catch(() => null)))}
      className="btn mt-3 text-sm"
    >
      {pending ? 'Signing out…' : 'Sign out of all devices'}
    </button>
  );
}
