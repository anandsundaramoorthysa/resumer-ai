'use client';

/**
 * The last boundary: a render error nothing below caught. React handles it here, so it
 * never reaches the browser's global error handler — which is why it is reported by hand.
 */

import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';
import './globals.css';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-paper text-ink antialiased">
        <main id="main" tabIndex={-1} className="mx-auto max-w-lg px-5 py-24">
          <p className="eyebrow">§ Error</p>
          <h1 className="mt-2 font-display text-3xl tracking-tight">Something went wrong</h1>
          <p className="mt-3 text-sm text-muted" role="alert">
            This page hit an error. It has been reported. Try again, or go back to the home page.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" onClick={reset} className="btn btn-primary">
              Try again
            </button>
            <Link href="/" className="btn">
              Home
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
