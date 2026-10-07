import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { requireApprovedUser } from '@/lib/server/approval';
import { db } from '@/lib/db';
import { applications } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { Ledger } from './ledger';
import type { ApplicationStatus } from './actions';

export const metadata = { title: 'Applications' };
export const dynamic = 'force-dynamic';

export default async function ApplicationsPage() {
  const session = await requireApprovedUser();

  const rows = await db
    .select()
    .from(applications)
    .where(eq(applications.userId, session.user.id))
    .orderBy(desc(applications.createdAt));

  const sent = rows.filter((r) => r.status !== 'draft');
  const interviews = rows.filter(
    (r) => r.status === 'interview' || r.status === 'offer',
  );
  const scored = rows.filter((r) => r.score != null);

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/applications" width="6xl" session={session} />

      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-5 py-8 outline-none">
        <p className="eyebrow">§ Applications</p>
        <h1 className="mt-1 font-display text-4xl tracking-tight">Applications</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Each row points at the exact resume that was sent, frozen at export — not at
          your profile as it looks today. Status is manual: it only changes when you
          change it here. Nothing is detected from your inbox or the employer.
        </p>

        {rows.length === 0 ? (
          <div className="mt-8 border-t border-line pt-6">
            <p className="font-display text-xl">Nothing tracked yet</p>
            <p className="mt-2 max-w-md text-sm text-muted">
              Every resume you draft lands here automatically. Mark one as applied when
              you send it, and record the outcome when you hear back.
            </p>
            <Link href="/" className="btn btn-primary mt-5 inline-flex">
              Draft a resume
            </Link>
          </div>
        ) : (
          <>
            <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-4">
              <Stat label="Drafted" value={String(rows.length)} />
              <Stat label="Sent" value={String(sent.length)} />
              <Stat label="Interviews" value={String(interviews.length)} />
              <Stat
                label="Average score"
                value={
                  scored.length
                    ? (
                        scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length
                      ).toFixed(1)
                    : '—'
                }
              />
            </dl>
            <Ledger
              rows={rows.map((r) => ({
                id: r.id,
                roleTitle: r.roleTitle,
                company: r.company,
                category: r.category,
                score: r.score,
                status: r.status as ApplicationStatus,
                createdAt: r.createdAt.toISOString(),
                resumeSnapshotId: r.resumeSnapshotId,
              }))}
            />
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 font-mono text-2xl font-semibold tabular">{value}</dd>
    </div>
  );
}
