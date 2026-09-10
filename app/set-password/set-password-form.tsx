'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { checkPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-rules';
import type { AuthResult } from '../sign-in/account-actions';
import { setInitialPasswordAction } from './actions';

/**
 * Deliberately the same shape and the same rules as the reset form.
 *
 * The strength check runs here as the user types purely so the problems appear before a
 * round trip; the server runs `initialPasswordVerdict` again on the row it is about to
 * write, which is the check that counts. `checkPassword` is imported from
 * password-rules.ts rather than password.ts for the reason that file gives — the hashing
 * module pulls in `node:crypto`, which has no business in a browser bundle.
 *
 * The email is passed in and fed to `checkPassword` so the "that contains your address"
 * rule fires in the browser too, instead of only after a submit that looked fine.
 */
export function SetPasswordForm({ email }: { email: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<AuthResult | null>(null);
  const [pending, startTransition] = useTransition();

  const strength = checkPassword(password, email);
  const matches = confirm.length === 0 || confirm === password;
  const canSubmit = strength.ok && confirm === password && !pending && !result?.ok;

  if (result?.ok) {
    return (
      <div className="mt-5">
        <p className="text-sm text-success" role="status">
          {result.message}
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
        >
          Continue
        </Link>
      </div>
    );
  }

  return (
    <form
      className="mt-5 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setResult(null);
        startTransition(async () => setResult(await setInitialPasswordAction(password)));
      }}
    >
      {/*
        A hidden username field, and it is not decorative: without one, a password manager
        offering to save this has no address to file it under, and stores a credential the
        user can never match back to this site.
      */}
      <input type="hidden" name="email" autoComplete="username" value={email} readOnly />

      <label className="block">
        <span className="text-xs font-medium text-muted">Password</span>
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
