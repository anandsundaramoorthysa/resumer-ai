import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/server/session';
import { db } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { latestConsent } from '@/lib/legal/consent';
import { LEGAL_LINKS, POLICY_VERSION } from '@/lib/legal/config';
import { formatDate } from '@/lib/format';
import { ChangePasswordForm, SignOutEverywhere } from './security-forms';
import { AppHeader } from '@/components/app-header';
import { DeleteAccount } from './delete-account';
import Link from 'next/link';
import { isOwnerSession } from '@/lib/server/approval';

export const metadata = { title: 'Your account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await getSession();
  if (!session?.user?.id) redirect('/sign-in');

  const [user] = await db
    .select({ email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  const consent = await latestConsent(session.user.id);
  const linked = await db.select({ provider: accounts.provider }).from(accounts).where(eq(accounts.userId, session.user.id));
  const PROVIDER_NAMES: Record<string, string> = { github: 'GitHub', google: 'Google' };
  const methods = [
    ...(user?.passwordHash ? ['password'] : []),
    ...linked.map((l) => PROVIDER_NAMES[l.provider] ?? l.provider),
  ];

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/settings/account" width="6xl" session={session} />

      <main id="main" tabIndex={-1} className="mx-auto max-w-3xl px-5 py-8 outline-none">
        <p className="eyebrow">§ Settings</p>
        <h1 className="mt-1 font-display text-4xl tracking-tight">Your account</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Signed in as <span className="font-mono">{user?.email}</span>. Your profile, resumes and
          answers belong to you: take a copy whenever you like, and close the account when you are
          done with it.
        </p>

        {(await isOwnerSession(session)) ? (
          <section className="mt-8 border-t border-line pt-4">
            <p className="eyebrow">§ 01 Owner</p>
            <h2 className="mt-1 font-display text-lg">New accounts</h2>
            <p className="mt-1.5 max-w-prose text-sm text-muted">
              You are the site owner. Everyone who signs up waits for you to approve or deny them.
            </p>
            <Link
              href="/admin/approvals"
              className="btn btn-primary mt-3 inline-flex text-sm"
            >
              Review new accounts
            </Link>{' '}
            <Link href="/admin/invites" className="btn mt-3 inline-flex text-sm">
              Invite codes
            </Link>
          </section>
        ) : null}

        <section className="mt-8 border-t border-line pt-4" aria-labelledby="signin-heading">
          <p className="eyebrow">§ 02 Sign-in</p>
          <h2 id="signin-heading" className="mt-1 font-display text-lg">Sign-in methods and password</h2>
          <p className="mt-1.5 max-w-prose text-sm text-muted">
            Connected: {methods.join(', ') || 'none'}. Methods cannot be unlinked here, so you can
            never lock yourself out.
          </p>
          {user?.passwordHash ? (
            <ChangePasswordForm email={user.email ?? ''} />
          ) : (
            <Link href="/set-password" className="btn mt-3 inline-flex text-sm">
              Set a password
            </Link>
          )}
          <SignOutEverywhere />
        </section>

        <section className="mt-8 border-t border-line pt-4">
          <p className="eyebrow">§ 03 Consent</p>
          <h2 className="mt-1 font-display text-lg">Terms and privacy</h2>
          <p className="mt-1.5 max-w-prose text-sm text-muted">
            {consent
              ? `You accepted version ${consent.policyVersion} on ${formatDate(consent.acceptedAt)}.`
              : 'You have not accepted the current version yet.'}{' '}
            Current version: {POLICY_VERSION}. To withdraw consent, delete your account below.
          </p>
          <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
            {LEGAL_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="inline-flex min-h-11 items-center underline">
                {l.label}
              </Link>
            ))}
          </p>
        </section>

        <section className="mt-8 border-t border-line pt-4">
          <p className="eyebrow">§ 04 Data</p>
          <h2 className="mt-1 font-display text-lg">Download your data</h2>
          <p className="mt-1.5 max-w-prose text-sm text-muted">
            One JSON file with your account details, contact details, every profile fact, your
            jobs, every resume this app generated, your applications, your saved application
            answers, dismissed suggestions, radar and sync runs, usage counts, your consent record
            and the record of what changed and when. It never includes password hashes or tokens.
          </p>
          <a
            href="/api/account/export"
            className="btn mt-3 inline-flex text-sm"
          >
            Download JSON
          </a>
        </section>

        <DeleteAccount hasPassword={Boolean(user?.passwordHash)} email={user?.email ?? ''} />
      </main>
    </div>
  );
}
