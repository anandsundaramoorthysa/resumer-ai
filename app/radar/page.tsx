import Link from 'next/link';
import { eq, sql } from 'drizzle-orm';
import { requireApprovedUser } from '@/lib/server/approval';
import { db } from '@/lib/db';
import { profileRecords } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { Logo } from '@/components/logo';
import { ThemeCorner } from '@/components/theme-corner';
import { RunView } from '@/components/radar/run-view';
import { canShowPublicDemo } from './demo-gate';

export const metadata = { title: 'Job Radar' };
export const dynamic = 'force-dynamic';

export default async function RadarPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo } = await searchParams;
  // Public demo: no session, no database, no approval. Synthetic data only.
  const publicDemo = canShowPublicDemo(process.env, demo);

  let hasProfile = false;
  if (!publicDemo) {
    const session = await requireApprovedUser();
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(profileRecords)
      .where(eq(profileRecords.userId, session.user.id));
    hasProfile = (row?.n ?? 0) > 0;
  }

  return (
    <div className="min-h-screen min-h-dvh">
      {publicDemo ? (
        <header className="border-b border-line bg-paper">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-5">
            <Link href="/" className="inline-flex min-h-11 items-center" aria-label="Resumer AI">
              <Logo size={28} />
            </Link>
            <div className="flex items-center gap-2">
              <ThemeCorner inline />
              <Link href="/sign-in" className="btn">
                Sign in
              </Link>
            </div>
          </div>
        </header>
      ) : (
        <AppHeader current="/radar" width="6xl" />
      )}
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-5 py-8 outline-none">
        <p className="eyebrow">§ Job Radar</p>
        <h1 className="mt-1 max-w-3xl font-display text-4xl tracking-tight">
          Find openings that fit what you can actually prove.
        </h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Searches Google Jobs through SerpApi, then ranks each posting against your resume. Scores come from skills you
          already show, not from guesses about you.
        </p>
        <RunView demo={demo === '1'} publicDemo={publicDemo} hasProfile={hasProfile} />
      </main>
    </div>
  );
}
