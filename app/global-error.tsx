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
        <main className="mx-auto max-w-lg px-4 py-24">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="mt-3">This page hit an error. It has been reported. Try again, or go back to the home page.</p>
          <div className="mt-6 flex gap-3">
            <button type="button" onClick={reset} className="rounded border px-4 py-2">
              Try again
            </button>
            <Link href="/" className="rounded border px-4 py-2">
              Home
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
