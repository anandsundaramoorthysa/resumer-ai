import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { db, isDatabaseConfigured } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { Logo } from '@/components/logo';
import { needsInitialPassword } from '@/lib/auth/initial-password';
import { SetPasswordForm } from './set-password-form';

export const metadata = { title: 'Create a password' };
export const dynamic = 'force-dynamic';

/**
 * The one-time "create a password" step, shown between an OAuth sign-in and the app.
 *
 * Why it is a stop on the way in rather than a wall around the app:
 *
 * `oauthSignInAction` sends every provider sign-in here, and this page waves through
 * anyone who already has a password — so an account that has set one never sees it again,
 * and one that has not is asked on each sign-in. That was chosen over enforcing it in
 * middleware on every route. A hard gate would have to be evaluated on every request in
 * an app that has no middleware at all today, and its failure mode is a user locked out
 * of the resume they were in the middle of writing because they will not pick a password
 * this minute. Asking at the door instead costs one skipped step and no data.
 *
 * The step is deliberately not offered to accounts that already sign in with a password:
 * changing one goes through the reset flow, which requires the inbox.
 */
export default async function SetPasswordPage() {
  if (!isDatabaseConfigured) redirect('/');

  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');

  const [account] = await db
    .select({
      email: users.email,
      passwordHash: users.passwordHash,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  // Nothing to do — including for the account that just set one and refreshed the page,
  // and for the row that has somehow not been verified, which must go through the email
  // link rather than acquire a working password here.
  if (!needsInitialPassword(account)) redirect('/');

  return (
    <main className="grid min-h-screen min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
        <Logo size={40} showWordmark={false} className="mb-5" />
        <h1 className="font-display text-2xl">Create a password</h1>
        <p className="mt-2 text-sm text-muted">
          You signed in with a provider, so{' '}
          {account.email ? <span className="text-ink">{account.email}</span> : 'your address'}{' '}
          has no password yet — which means email sign-in does not work for you. Setting
          one now gives you a second way in if you ever lose access to that provider.
        </p>

        <SetPasswordForm email={account.email ?? ''} />

        <Link
          href="/"
          className="mt-5 inline-flex min-h-11 items-center text-xs text-muted underline hover:text-ink"
        >
          Not now — keep signing in with my provider
        </Link>
      </div>
    </main>
  );
}
