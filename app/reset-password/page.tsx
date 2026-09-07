import Link from 'next/link';
import { Logo } from '@/components/logo';
import { ResetPasswordForm } from './reset-form';

export const metadata = { title: 'Set a new password' };
export const dynamic = 'force-dynamic';

/**
 * The token is not checked on load, only on submit.
 *
 * Checking it here would spend it: a mail client that prefetches the link would consume
 * the reset before the person ever saw the form. So the page renders unconditionally and
 * the single-use check happens once, at the moment the new password arrives.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
        <Logo size={40} showWordmark={false} className="mb-5" />
        <h1 className="font-display text-2xl">Set a new password</h1>

        {token ? (
          <>
            <p className="mt-2 text-sm text-muted">
              Choose something you will remember. A phrase is stronger than a short
              password with symbols in it, and easier to type on a phone.
            </p>
            <ResetPasswordForm token={token} />
          </>
        ) : (
          <p className="mt-2 text-sm text-danger">
            This page needs the link from your email — open it from there rather than
            typing the address.
          </p>
        )}

        <Link
          href="/sign-in"
          className="mt-5 inline-flex min-h-11 items-center text-xs text-muted underline hover:text-ink"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
