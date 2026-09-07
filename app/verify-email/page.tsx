import Link from 'next/link';
import { Logo } from '@/components/logo';
import { verifyEmailAction } from '../sign-in/account-actions';

export const metadata = { title: 'Confirm your email' };
export const dynamic = 'force-dynamic';

/**
 * The link is spent on load rather than behind a button.
 *
 * A confirmation page with a "confirm" button is one extra step for the user and no
 * extra safety: anyone holding the link can press the button. The token is single-use
 * server-side, so a mail client that prefetches the URL spends it and the person then
 * sees the used-link message — which is why that message says how to get another rather
 * than only that this one failed.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const result = token
    ? await verifyEmailAction(token)
    : { ok: false, message: 'That link is missing its token. Open it from the email directly.' };

  return (
    <main className="grid min-h-screen min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
        <Logo size={40} showWordmark={false} className="mb-5" />
        <h1 className="font-display text-2xl">
          {result.ok ? 'Email confirmed' : 'That link did not work'}
        </h1>
        <p className="mt-2 text-sm text-muted">{result.message}</p>

        <Link
          href="/sign-in"
          className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
        >
          {result.ok ? 'Sign in' : 'Back to sign in'}
        </Link>

        {!result.ok ? (
          <p className="mt-3 text-xs text-muted">
            The sign-in page can send a fresh confirmation email — enter your address and
            use &ldquo;Resend the confirmation email&rdquo;.
          </p>
        ) : null}
      </div>
    </main>
  );
}
