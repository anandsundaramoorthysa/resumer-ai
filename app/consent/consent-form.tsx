'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { acceptConsentAction } from './actions';

export function ConsentForm() {
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="mt-6"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          // On success the action redirects, so a value coming back is a refusal.
          const r = await acceptConsentAction(accepted).catch(() => null);
          if (r && !r.ok) setError(r.message);
        });
      }}
    >
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          required
          className="mt-1 h-5 w-5 shrink-0"
        />
        <span>
          I am 18 or older and I agree to the{' '}
          <Link href="/terms" target="_blank" className="underline">Terms</Link> and{' '}
          <Link href="/privacy" target="_blank" className="underline">Privacy Policy</Link>.
        </span>
      </label>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={!accepted || pending} className="btn btn-primary">
          {pending ? 'Saving…' : 'Continue'}
        </button>
        <Link href="/settings/account" className="inline-flex min-h-11 items-center text-sm text-muted underline">
          Delete my account instead
        </Link>
      </div>
    </form>
  );
}
