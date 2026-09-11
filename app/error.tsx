'use client';

/**
 * A page that threw while rendering. Without this, Next's bare "Application error" text
 * replaced the whole page; this keeps the header's place and offers the two ways forward.
 * Reported to Sentry by hand, because an error boundary catches what the browser's global
 * handler would otherwise have seen.
 */

import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="mx-auto max-w-lg px-5 py-24">
      <h1 className="font-display text-3xl">This page hit a problem</h1>
      <p className="mt-3 text-sm text-muted">
        Nothing you saved was lost. It has been reported — try again, or go back to the dashboard.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-on-brand hover:bg-brand-dark"
        >
          Try again
        </button>
        <Link href="/" className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold hover:bg-paper">
          Dashboard
        </Link>
      </div>
    </main>
  );
}
