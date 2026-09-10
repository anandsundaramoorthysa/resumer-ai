import Link from 'next/link';
import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { applications } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
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
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/applications" width="6xl" />

      <main className="mx-auto max-w-6xl px-5 py-8">
        <h1 className="font-display text-3xl">Applications</h1>
        {/* Kept at prose width deliberately. The shell is max-w-6xl because this page
            holds a six-column table, and the table is what that width is for; stretching
            a paragraph to 1152px to match the table's right edge would trade readable
            line length for a flush edge, which is backwards. */}
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

            {/*
              * Below `sm` this is a list of cards, not a table.
              *
              * Six columns do not fit a phone. In a horizontal scroller at 320px, 623px
              * of table sat in 278px — Score, Status, Drafted and the Review link were
              * all off-screen behind an overlay scrollbar that occupies no layout and
              * fades out, so the card's rounded right edge sat flush at the viewport and
              * the whole thing read as a finished table rather than a truncated one.
              * Nothing indicated there was more.
              *
              * The auto table layout also gave the Role cell whatever the other five
              * columns did not want, which collapsed a long job title to a 95px column
              * running six lines deep.
              */}
            <ul className="mt-6 space-y-3 sm:hidden">
              {rows.map((r) => (
                <li key={r.id} className="rounded-xl border border-line bg-surface p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">{r.roleTitle}</p>
                      {r.company ? (
                        <p className="mt-0.5 text-xs text-muted">{r.company}</p>
                      ) : null}
                    </div>
                    <span
                      className={`flex-none font-mono text-lg font-semibold tabular ${
                        r.score == null
                          ? 'text-muted'
                          : r.score >= 8.5
                            ? 'text-success'
                            : 'text-warning'
                      }`}
                    >
                      {r.score?.toFixed(1) ?? '—'}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand-dark">
                      {r.category}
                    </span>
                    <StatusSelect id={r.id} status={r.status as ApplicationStatus} />
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-2">
                    <span className="text-xs text-muted">
                      {r.createdAt.toLocaleDateString()}
                    </span>
                    <Link
                      href={`/resume/${r.resumeSnapshotId}`}
                      /* min-w-11 as well as min-h-11: the word "Review" at text-xs is
                         40.7px wide, so height alone left the tap target short in one
                         dimension. Centred, so the 3px it gains does not shift the text
                         off the right edge of the cell. */
                      className="inline-flex min-h-11 min-w-11 items-center justify-center text-xs font-semibold text-brand-dark hover:underline"
                    >
                      Review
                    </Link>
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-6 hidden overflow-x-auto rounded-xl border border-line bg-surface sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="min-w-56 px-4 py-3 font-medium">Role</th>
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
                      <td className="min-w-56 px-4 py-3">
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
                          r.score == null
                            ? 'text-muted'
                            : r.score >= 8.5
                              ? 'text-success'
                              : 'text-warning'
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
                          /* min-w-11 as well as min-h-11: the word "Review" at text-xs is
                         40.7px wide, so height alone left the tap target short in one
                         dimension. Centred, so the 3px it gains does not shift the text
                         off the right edge of the cell. */
                      className="inline-flex min-h-11 min-w-11 items-center justify-center text-xs font-semibold text-brand-dark hover:underline"
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
