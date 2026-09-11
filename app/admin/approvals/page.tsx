import { notFound } from 'next/navigation';
import { auth } from '@/auth';
import { AppHeader } from '@/components/app-header';
import { accountsForReview, isOwnerSession } from '@/lib/server/approval';
import { DecisionButtons } from './decision-buttons';

export const metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

const when = (d: Date | null) =>
  d ? `${d.toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} UTC` : '—';

/**
 * The owner's review of new accounts. Anyone else gets a plain 404: this page should not
 * even confirm that it exists to someone who is not allowed to use it.
 */
export default async function ApprovalsPage() {
  const session = await auth();
  if (!(await isOwnerSession(session))) notFound();

  const { pending, decided } = await accountsForReview();

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader width="6xl" />
      <main className="mx-auto max-w-4xl px-5 py-8">
        <h1 className="font-display text-3xl">New accounts</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Someone who signs up can sign in and see a waiting page, and nothing else, until you
          decide. Approved accounts get the normal limit of 400 AI calls a day; denied ones stay
          locked out and can delete themselves. Either way they are told by email.
        </p>

        <section className="mt-7" aria-labelledby="pending-heading">
          <h2 id="pending-heading" className="font-display text-xl">
            Waiting ({pending.length})
          </h2>
          {pending.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nobody is waiting.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {pending.map((a) => (
                <li key={a.id} className="rounded-xl border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold [overflow-wrap:anywhere]">{a.email ?? '(no email)'}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {a.name ? `${a.name} · ` : ''}signed up {when(a.createdAt)} ·{' '}
                        {a.emailVerified ? 'address confirmed' : 'address NOT confirmed yet'}
                      </p>
                    </div>
                    <DecisionButtons userId={a.id} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {decided.length > 0 ? (
          <section className="mt-10" aria-labelledby="decided-heading">
            <h2 id="decided-heading" className="font-display text-xl">Recently decided</h2>
            <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
              {decided.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="[overflow-wrap:anywhere]">{a.email}</span>
                  <span className="flex items-center gap-3">
                    <span className={a.approval === 'approved' ? 'text-success' : 'text-danger'}>
                      {a.approval === 'approved' ? 'Approved' : 'Denied'} {when(a.decidedAt)}
                    </span>
                    <DecisionButtons userId={a.id} current={a.approval as 'approved' | 'denied'} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}
