import { requireApprovedUser } from '@/lib/server/approval';
import { AppHeader } from '@/components/app-header';
import { RunView } from '@/components/radar/run-view';

export const metadata = { title: 'Job Radar' };
export const dynamic = 'force-dynamic';

export default async function RadarPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  await requireApprovedUser();
  const { demo } = await searchParams;

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/radar" width="6xl" />
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-5 py-8 outline-none">
        <p className="eyebrow">§ Job Radar</p>
        <h1 className="mt-1 max-w-3xl font-display text-4xl tracking-tight">
          Find openings that fit what you can actually prove.
        </h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Searches Google Jobs through SerpApi, then ranks each posting against your resume. Scores come from skills you
          already show, not from guesses about you.
        </p>
        <RunView demo={demo === '1'} />
      </main>
    </div>
  );
}
