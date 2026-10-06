import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { DeleteAccount } from './delete-account';
import Link from 'next/link';
import { isOwnerSession } from '@/lib/server/approval';

export const metadata = { title: 'Your account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');

  const [user] = await db
    .select({ email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/settings/account" width="6xl" />

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
            </Link>
          </section>
        ) : null}

        <section className="mt-8 border-t border-line pt-4">
          <p className="eyebrow">§ 02 Data</p>
          <h2 className="mt-1 font-display text-lg">Download your data</h2>
          <p className="mt-1.5 max-w-prose text-sm text-muted">
            One JSON file with your contact details, every profile fact, your jobs, every resume
            this app generated, your applications, your saved application answers and the record of
            what changed and when.
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
