import { redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { profileRecords, users } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { PortfolioForm } from './portfolio-form';
import { AppInstallPanel } from './app-install';

export const metadata = { title: 'Portfolio connection' };
export const dynamic = 'force-dynamic';

export default async function PortfolioSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ installed?: string; installError?: string }>;
}) {
  const { installed, installError } = await searchParams;
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  const userId = session.user.id;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      synced: sql<number>`count(*) filter (where ${profileRecords.source} = 'github-sync')::int`,
      flagged: sql<number>`count(*) filter (where ${profileRecords.flaggedForRemoval})::int`,
    })
    .from(profileRecords)
    .where(eq(profileRecords.userId, userId));

  return (
    <div className="min-h-screen">
      <AppHeader current="/settings/portfolio" width="3xl" />

      <main className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="font-display text-3xl">Portfolio connection</h1>
        <p className="mt-2 text-sm text-muted">
          Resumer AI reads your skills, projects and experience from the repository behind
          your portfolio site. Before every draft it checks whether that repo has changed —
          a single API call — and only re-reads it when the commit is new.
        </p>

        <AppInstallPanel
          userId={userId}
          currentRepo={user?.portfolioRepo ?? null}
          notice={
            installed
              ? { kind: 'installed', message: installed }
              : installError
                ? { kind: 'error', message: installError }
                : undefined
          }
        />

        <PortfolioForm
          currentRepo={user?.portfolioRepo ?? null}
          lastSyncedAt={user?.lastSyncedAt ? user.lastSyncedAt.toISOString() : null}
          recordCount={counts?.total ?? 0}
          syncedCount={counts?.synced ?? 0}
          flaggedCount={counts?.flagged ?? 0}
        />

        <section className="mt-10 rounded-xl border border-line bg-surface p-5">
          <h2 className="font-display text-lg">What gets read, and what never changes</h2>
          <ul className="mt-3 space-y-2.5 text-sm text-muted">
            <li>
              <strong className="text-ink">Read-only.</strong> The app never writes to your
              repositories. It reads structured data files directly, and uses an AI pass
              only for content hardcoded inside components.
            </li>
            <li>
              <strong className="text-ink">Your manual edits win.</strong> Anything you type
              into your profile by hand is never modified or removed by a sync, no matter
              what changes upstream.
            </li>
            <li>
              <strong className="text-ink">Nothing is deleted automatically.</strong> If
              something disappears from your portfolio, the matching record is flagged for
              you to review — a parsing miss should cost you a moment&apos;s attention, not a
              piece of your work history.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
