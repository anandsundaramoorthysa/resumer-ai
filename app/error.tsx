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
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg px-5 py-24">
      <p className="eyebrow">§ Error</p>
      <h1 className="mt-2 font-display text-3xl tracking-tight">This page hit a problem</h1>
      <p className="mt-3 text-sm text-muted" role="alert">
        Nothing you saved was lost. It has been reported. Try again, or go back to the dashboard.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" onClick={reset} className="btn btn-primary">
          Try again
        </button>
        <Link href="/" className="btn">
          Dashboard
        </Link>
      </div>
    </main>
  );
}
