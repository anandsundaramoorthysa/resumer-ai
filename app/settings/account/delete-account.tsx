'use client';

/**
 * Closing the account. Two steps on purpose — a button that reveals a confirmation, and a
 * confirmation that has to be typed — because this deletes everything and cannot be undone.
 */

import { useState, useTransition } from 'react';
import { deleteAccount } from './actions';
import { PasswordInput } from '@/components/password-input';

export function DeleteAccount({ hasPassword, email }: { hasPassword: boolean; email: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await deleteAccount(value).catch(() => null);
      // On success the action signs out and redirects, so anything returned here failed.
      if (r && !r.ok) setError(r.message);
    });
  };

  return (
    <section className="mt-5 rounded-xl border border-danger bg-surface p-5">
      <h2 className="font-display text-lg text-danger">Delete your account</h2>
      <p className="mt-1.5 max-w-prose text-sm text-muted">
        Everything goes: your profile, your jobs, every resume, your applications, your answers and
        your sign-in. This cannot be undone, so download your data first if you want a copy.
      </p>

      {open ? (
        <form onSubmit={submit} className="mt-3">
          <label className="block max-w-sm">
            <span className="text-xs font-medium text-muted">
              {hasPassword ? 'Type your password to confirm' : `Type ${email} to confirm`}
            </span>
            {hasPassword ? (
              <PasswordInput
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="current-password"
                className="mt-1 min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-sm outline-none focus:border-danger"
              />
            ) : (
              <input
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                className="mt-1 min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-sm outline-none focus:border-danger"
              />
            )}
          </label>
          {error ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={pending || value.trim().length === 0}
              className="min-h-11 rounded-lg border border-danger bg-surface px-4 text-sm font-semibold text-danger hover:bg-danger-tint disabled:opacity-50"
            >
              {pending ? 'Deleting…' : 'Delete everything'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setValue('');
                setError(null);
              }}
              className="min-h-11 rounded-lg px-4 text-sm font-semibold text-muted hover:text-ink"
            >
              Keep my account
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 min-h-11 rounded-lg border border-danger px-4 text-sm font-semibold text-danger hover:bg-danger-tint"
        >
          Delete my account
        </button>
      )}
    </section>
  );
}
