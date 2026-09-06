import Link from 'next/link';
import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { applications } from '@/lib/db/schema';
import { Logo } from '@/components/logo';
import { StatusSelect } from './status-select';
import type { ApplicationStatus } from './actions';

export const metadata = { title: 'Applications' };
export const dynamic = 'force-dynamic';

export default async function ApplicationsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');

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
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5">
          <Link href="/" className="inline-flex min-h-11 items-center">
            <Logo />
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link href="/profile" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
              Profile
            </Link>
            <Link href="/" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
              Dashboard
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8">
        <h1 className="font-display text-3xl">Applications</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Each row points at the exact resume that was sent, frozen at export — not at
          your profile as it looks today. Change your profile later and this record still
          shows what the recruiter actually read.
        </p>

        {rows.length === 0 ? (
          <div className="mt-8 rounded-xl border border-dashed border-line p-8 text-center">
            <p className="font-display text-xl">Nothing tracked yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              Every resume you draft lands here automatically. Mark one as applied when
              you send it, and record the outcome when you hear back.
            </p>
            <Link
              href="/"
              className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
            >
              Draft a resume
            </Link>
          </div>
        ) : (
          <>
            <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Drafted" value={String(rows.length)} />
              <Stat label="Sent" value={String(sent.length)} />
              <Stat label="Interviews" value={String(interviews.length)} accent />
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

            <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Category</th>
                    <th className="px-4 py-3 font-medium">Score</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Drafted</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-3">
                        <div className="font-semibold">{r.roleTitle}</div>
                        {r.company ? (
                          <div className="text-xs text-muted">{r.company}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand-dark">
                          {r.category}
                        </span>
                      </td>
                      <td
                        className={`px-4 py-3 font-mono font-semibold tabular ${
                          (r.score ?? 0) >= 8.5 ? 'text-success' : 'text-warning'
                        }`}
                      >
                        {r.score?.toFixed(1) ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <StatusSelect id={r.id} status={r.status as ApplicationStatus} />
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {r.createdAt.toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/resume/${r.resumeSnapshotId}`}
                          className="text-xs font-semibold text-brand-dark hover:underline"
                        >
                          Review
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd
        className={`mt-1.5 font-mono text-2xl font-semibold tabular ${
          accent ? 'text-gold' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
