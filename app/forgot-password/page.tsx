import Link from 'next/link';
import { Logo } from '@/components/logo';
import { ForgotPasswordForm } from './forgot-form';

export const metadata = { title: 'Reset your password' };

export default function ForgotPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
        <Logo size={40} showWordmark={false} className="mb-5" />
        <h1 className="font-display text-2xl">Reset your password</h1>
        <p className="mt-2 text-sm text-muted">
          Enter the address you signed up with and we&apos;ll send a link that lets you set
          a new password. The link works once and lasts an hour.
        </p>

        <ForgotPasswordForm />

        <p className="mt-5 text-xs text-muted">
          If you signed in with GitHub or Google, there is no password to reset — use that
          button on the sign-in page instead.
        </p>

        <Link
          href="/sign-in"
          className="mt-4 inline-flex min-h-11 items-center text-xs text-muted underline hover:text-ink"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
