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
          className="field mt-1"
        />
      </label>

      <button
        type="submit"
        disabled={pending || email.trim().length < 4}
        className="mt-4 btn btn-primary w-full"
      >
        {pending ? 'Sending…' : 'Send the link'}
      </button>

      {result ? (
        <p className={`mt-3 text-sm ${result.ok ? 'text-success' : 'text-danger'}`} role={result.ok ? 'status' : 'alert'}>
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
