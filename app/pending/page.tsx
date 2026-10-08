import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AppHeader } from '@/components/app-header';
import { approvalFor } from '@/lib/server/approval';
import { hasCurrentConsent } from '@/lib/legal/consent';
import { autoApproveIfOpen } from '@/lib/legal/invites';
import { RETENTION, signupMode } from '@/lib/legal/config';
import { LegalFooter } from '@/components/legal-footer';
import { InviteForm } from './invite-form';

export const metadata = { title: 'Waiting for approval' };
export const dynamic = 'force-dynamic';

/** Where every page sends an account the owner has not approved (lib/server/approval.ts). */
export default async function PendingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  if (!(await hasCurrentConsent(session.user.id))) redirect('/consent');
  let approval = await approvalFor(session.user.id);
  // SIGNUP_MODE=open: a pending account is approved on its first visit, under the daily quota.
  if (approval === 'pending' && (await autoApproveIfOpen(session.user.id)) === 'approved') approval = 'approved';
  if (approval === 'approved') redirect('/');
  const inviteOpen = signupMode() === 'invite' && approval === 'pending';

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader width="6xl" minimal />
      <main id="main" tabIndex={-1} className="mx-auto max-w-lg px-5 py-20">
        {approval === 'denied' ? (
          <>
            <p className="eyebrow">Account status</p>
            <h1 className="mt-2 font-display text-3xl tracking-tight">This sign-up was not approved</h1>
            <p className="mt-4 max-w-prose text-muted">
              Access to Resumer AI is limited right now, and the site owner did not approve this
              account. Nothing you entered is used for anything.
            </p>
            <Link href="/settings/account" className="btn mt-6">
              Delete this account
            </Link>
            <p className="mt-4 max-w-prose text-sm text-muted">
              Accounts that are not approved are deleted automatically after {RETENTION.deniedAccountDays}{' '}
              days. Questions? <Link href="/contact" className="underline">Contact us</Link>.
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow">Account status</p>
            <h1 className="mt-2 font-display text-3xl tracking-tight">Waiting for owner approval</h1>
            <p className="mt-4 max-w-prose">
              Access is limited, because every account uses the same paid AI services. An account is
              approved either by a valid invite code (up to a daily limit) or by the site owner by
              hand. Yours is in the queue.
            </p>
            {inviteOpen ? (
              <section className="mt-6" aria-labelledby="invite-heading">
                <h2 id="invite-heading" className="eyebrow">
                  Have an invite code?
                </h2>
                <InviteForm />
              </section>
            ) : null}
            <section className="mt-8 border-t border-line pt-4" aria-labelledby="next-heading">
              <h2 id="next-heading" className="eyebrow">
                What happens next
              </h2>
              <ol className="mt-3 max-w-prose list-decimal space-y-2 pl-5 text-muted">
                <li>
                  The owner reviews your sign-up. There is no set time, and nothing for you to do
                  meanwhile.
                </li>
                <li>
                  You get an email at <span className="font-mono text-ink">{session.user.email}</span>{' '}
                  as soon as it is approved.
                </li>
                <li>Reload this page after that email and the app opens as normal.</li>
              </ol>
            </section>
            <p className="mt-6 max-w-prose text-muted">
              No email yet? Check your spam folder, then come back to this page. It redirects you
              automatically once you are approved.
            </p>
            <Link href="/settings/account" className="mt-6 inline-flex min-h-11 items-center text-sm text-muted underline">
              Changed your mind? Delete the account
            </Link>
          </>
        )}
        <LegalFooter className="mt-12" />
      </main>
    </div>
  );
}
