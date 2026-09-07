'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { checkPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-rules';
import { resetPasswordAction, type AuthResult } from '../sign-in/account-actions';

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<AuthResult | null>(null);
  const [pending, startTransition] = useTransition();

  const strength = checkPassword(password);
  const matches = confirm.length === 0 || confirm === password;
  const canSubmit = strength.ok && confirm === password && !pending && !result?.ok;

  if (result?.ok) {
    return (
      <div className="mt-5">
        <p className="text-sm text-success" role="status">
          {result.message}
        </p>
        <Link
          href="/sign-in"
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form
      className="mt-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setResult(null);
        startTransition(async () => setResult(await resetPasswordAction(token, password)));
      }}
    >
      <label className="block">
        <span className="text-xs font-medium text-muted">New password</span>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className={INPUT}
        />
      </label>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-muted">Type it again</span>
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className={INPUT}
        />
      </label>

      <ul className="mt-2 space-y-1">
        {password.length === 0 ? (
          <li className="text-xs text-muted">At least {MIN_PASSWORD_LENGTH} characters.</li>
        ) : (
          strength.problems.map((p) => (
            <li key={p} className="text-xs text-muted">
              ○ {p}
            </li>
          ))
        )}
        {!matches ? <li className="text-xs text-danger">The two do not match.</li> : null}
      </ul>

      <button
        type="submit"
        disabled={!canSubmit}
        className="mt-4 min-h-11 w-full rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Set password'}
      </button>

      {result && !result.ok ? (
        <p className="mt-3 text-sm text-danger" role="status">
          {result.message}
          {result.problems?.length ? (
            <span className="mt-1 block text-xs text-muted">{result.problems.join(' ')}</span>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}

const INPUT =
  'mt-1 min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-sm outline-none focus:border-brand';
