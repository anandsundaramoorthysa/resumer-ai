'use client';

import { useState, useTransition } from 'react';
import { requestPasswordResetAction, type AuthResult } from '../sign-in/account-actions';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<AuthResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="mt-5"
      onSubmit={(e) => {
        e.preventDefault();
        setResult(null);
        startTransition(async () => setResult(await requestPasswordResetAction(email)));
      }}
    >
      <label className="block">
        <span className="text-xs font-medium text-muted">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className="mt-1 min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-sm outline-none focus:border-brand"
        />
      </label>

      <button
        type="submit"
        disabled={pending || email.trim().length < 4}
        className="mt-4 min-h-11 w-full rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
      >
        {pending ? 'Sending…' : 'Send the link'}
      </button>

      {result ? (
        <p className={`mt-3 text-sm ${result.ok ? 'text-success' : 'text-danger'}`} role="status">
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
