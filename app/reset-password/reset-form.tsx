'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { checkPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-rules';
import { resetPasswordAction, type AuthResult } from '../sign-in/account-actions';
import { PasswordInput } from '@/components/password-input';

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // One toggle for both fields, so what was typed twice can be compared by eye.
  const [showPasswords, setShowPasswords] = useState(false);
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
          className="mt-4 btn btn-primary w-full"
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
        <PasswordInput
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className={INPUT}
          visible={showPasswords}
          onVisibleChange={setShowPasswords}
        />
      </label>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-muted">Type it again</span>
        <PasswordInput
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className={INPUT}
          visible={showPasswords}
          onVisibleChange={setShowPasswords}
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
        className="mt-4 btn btn-primary w-full"
      >
        {pending ? 'Saving…' : 'Set password'}
      </button>

      {result && !result.ok ? (
        <p className="mt-3 text-sm text-danger" role="alert">
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
  'field mt-1';
