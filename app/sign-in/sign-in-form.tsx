'use client';

/**
 * The sign-in and sign-up form.
 *
 * One card with two modes rather than two pages: the difference between them is one
 * extra field, and a separate page for that costs a navigation at the exact moment
 * someone has decided to start.
 *
 * The password rules are shown while typing rather than after submitting. A rule that
 * only appears once the form has been rejected reads as an obstacle; the same rule shown
 * in advance reads as an instruction.
 */

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { checkPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-rules';
import { signUpAction, resendVerificationAction, type AuthResult } from './account-actions';
import { passwordSignInAction } from './sign-in-actions';

type Mode = 'sign-in' | 'sign-up';

export function SignInForm({ passwordEnabled }: { passwordEnabled: boolean }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<AuthResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (!passwordEnabled) return null;

  const strength = checkPassword(password, email);
  const canSubmit =
    email.trim().length > 3 &&
    password.length > 0 &&
    !pending &&
    (mode === 'sign-in' || strength.ok);

  const submit = () => {
    setResult(null);
    startTransition(async () => {
      setResult(
        mode === 'sign-in'
          ? await passwordSignInAction(email, password)
          : await signUpAction(email, password, name),
      );
    });
  };

  const resend = () => {
    setResult(null);
    startTransition(async () => setResult(await resendVerificationAction(email)));
  };

  return (
    <div className="mt-6 text-left">
      <div className="flex rounded-lg border border-line p-1" role="tablist">
        {(['sign-in', 'sign-up'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setResult(null);
            }}
            /* text-xs until `sm`: at 320px the tab box is 102px and "Create account"
               needs 104, so the label touched both rounded edges. */
            className={`min-h-11 flex-1 rounded-md px-1 text-xs font-semibold sm:text-sm ${
              mode === m ? 'bg-brand text-on-brand' : 'text-muted hover:text-ink'
            }`}
          >
            {m === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>

      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit();
        }}
      >
        {mode === 'sign-up' ? (
          <Labelled label="Your name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className={INPUT}
            />
          </Labelled>
        ) : null}

        <Labelled label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            className={INPUT}
          />
        </Labelled>

        <Labelled label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            required
            className={INPUT}
          />
        </Labelled>

        {mode === 'sign-up' ? (
          <ul className="mt-2 space-y-1">
            {password.length === 0 ? (
              <li className="text-xs text-muted">
                At least {MIN_PASSWORD_LENGTH} characters. A phrase you will remember beats
                a short one with symbols in it.
              </li>
            ) : strength.ok ? (
              <li className="text-xs text-success">✓ That will do.</li>
            ) : (
              /* Warning, not muted: an unmet rule rendered in the same grey as the
                 neutral pre-typing hint directly above it, so the two were
                 indistinguishable. Warning rather than danger — nothing has been
                 submitted or rejected, it is a rule still to meet. */
              strength.problems.map((p) => (
                <li key={p} className="text-xs text-warning">
                  ○ {p}
                </li>
              ))
            )}
          </ul>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-4 min-h-11 w-full rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
        >
          {pending
            ? 'Working…'
            : mode === 'sign-in'
              ? 'Sign in'
              : 'Create account'}
        </button>
      </form>

      {result ? (
        <p
          className={`mt-3 text-sm ${result.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {result.message}
          {result.problems?.length ? (
            <span className="mt-1 block text-xs text-muted">{result.problems.join(' ')}</span>
          ) : null}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-between gap-3 text-xs">
        <Link
          href="/forgot-password"
          className="inline-flex min-h-11 items-center text-muted underline hover:text-ink"
        >
          Forgot your password?
        </Link>
        {/* Offered unconditionally rather than only after a failed sign-in: the sign-in
            failure deliberately does not say whether the address is unconfirmed, so the
            way out has to be available without being told to look for it. */}
        <button
          type="button"
          onClick={resend}
          disabled={pending || email.trim().length < 4}
          className="inline-flex min-h-11 items-center text-muted underline hover:text-ink disabled:opacity-50"
        >
          Resend the confirmation email
        </button>
      </div>
    </div>
  );
}

const INPUT =
  'mt-1 min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-sm outline-none focus:border-brand';

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-3 block first:mt-0">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
