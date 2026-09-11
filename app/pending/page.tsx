import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AppHeader } from '@/components/app-header';
import { approvalFor } from '@/lib/server/approval';

export const metadata = { title: 'Waiting for approval' };
export const dynamic = 'force-dynamic';

/** Where every page sends an account the owner has not approved (lib/server/approval.ts). */
export default async function PendingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  const approval = await approvalFor(session.user.id);
  if (approval === 'approved') redirect('/');

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader width="6xl" />
      <main className="mx-auto max-w-lg px-5 py-20">
        {approval === 'denied' ? (
          <>
            <h1 className="font-display text-3xl">This sign-up was not approved</h1>
            <p className="mt-3 text-sm text-muted">
              Access to Resumer AI is limited right now, and the site owner did not approve this
              account. Nothing you entered is used for anything.
            </p>
            <Link
              href="/settings/account"
              className="mt-6 inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold hover:bg-paper"
            >
              Delete this account
            </Link>
          </>
        ) : (
          <>
            <h1 className="font-display text-3xl">Waiting for approval</h1>
            <p className="mt-3 text-sm text-muted">
              Thanks for signing up. The site owner approves each new account by hand, because every
              account uses the same AI services. You will get an email at{' '}
              <span className="font-mono">{session.user.email}</span> as soon as yours is ready — there is
              nothing else to do until then.
            </p>
            <Link href="/settings/account" className="mt-6 inline-flex min-h-11 items-center text-sm text-muted underline">
              Changed your mind? Delete the account
            </Link>
          </>
        )}
      </main>
    </div>
  );
}
