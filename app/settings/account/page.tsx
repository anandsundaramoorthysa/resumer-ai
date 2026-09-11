import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { DeleteAccount } from './delete-account';

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

      <main className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="font-display text-3xl">Your account</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Signed in as <span className="font-mono">{user?.email}</span>. Your profile, resumes and
          answers belong to you: take a copy whenever you like, and close the account when you are
          done with it.
        </p>

        <section className="mt-7 rounded-xl border border-line bg-surface p-5">
          <h2 className="font-display text-lg">Download your data</h2>
          <p className="mt-1.5 max-w-prose text-sm text-muted">
            One JSON file with your contact details, every profile fact, your jobs, every resume
            this app generated, your applications, your saved application answers and the record of
            what changed and when.
          </p>
          <a
            href="/api/account/export"
            className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold hover:bg-paper"
          >
            Download JSON
          </a>
        </section>

        <DeleteAccount hasPassword={Boolean(user?.passwordHash)} email={user?.email ?? ''} />
      </main>
    </div>
  );
}
