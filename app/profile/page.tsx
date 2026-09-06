import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { Logo } from '@/components/logo';
import { FlaggedRecord } from './flagged-record';

export const metadata = { title: 'Profile' };
export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<string, string> = {
  skill: 'Skills',
  'experience-bullet': 'Experience bullets',
  project: 'Projects',
  education: 'Education',
  certification: 'Certifications',
  achievement: 'Achievements',
};

/** One readable line per record, whatever its type. */
function describe(type: string, data: Record<string, unknown>): string {
  const s = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : '');
  switch (type) {
    case 'skill':
      return s('name');
    case 'experience-bullet':
      return s('text') || s('action');
    case 'project':
      return `${s('name')}${s('description') ? ` — ${s('description')}` : ''}`;
    case 'education':
      return [s('credential'), s('field'), s('institution')].filter(Boolean).join(' · ');
    case 'certification':
      return [s('name'), s('issuer')].filter(Boolean).join(' · ');
    case 'achievement':
      return [s('title'), s('description')].filter(Boolean).join(' — ');
    default:
      return JSON.stringify(data).slice(0, 120);
  }
}

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  const userId = session.user.id;

  const records = await db
    .select()
    .from(profileRecords)
    .where(eq(profileRecords.userId, userId));
  const roles = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.userId, userId));

  const flagged = records.filter((r) => r.flaggedForRemoval);
  const active = records.filter((r) => !r.flaggedForRemoval);

  const grouped = new Map<string, typeof records>();
  for (const r of active) {
    const list = grouped.get(r.type) ?? [];
    list.push(r);
    grouped.set(r.type, list);
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-3.5">
          <Link href="/" className="inline-flex min-h-11 items-center">
            <Logo />
          </Link>
          <nav className="flex flex-wrap items-center gap-4 text-sm">
            <Link href="/import" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
              Import
            </Link>
            <Link href="/settings/portfolio" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
              Portfolio
            </Link>
            <Link href="/settings/application" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
              Application answers
            </Link>
            <Link href="/" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
              Dashboard
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl">Your profile</h1>
            <p className="mt-1 text-sm text-muted">
              {active.length} fact{active.length === 1 ? '' : 's'} across {grouped.size}{' '}
              categor{grouped.size === 1 ? 'y' : 'ies'}
              {roles.length ? ` · ${roles.length} role${roles.length === 1 ? '' : 's'}` : ''}
            </p>
          </div>
        </div>

        {records.length === 0 ? (
          <div className="mt-8 rounded-xl border border-dashed border-line p-8 text-center">
            <p className="font-display text-xl">Nothing here yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              Every resume is built only from facts in this profile — that&apos;s what keeps
              the output honest. Connect your portfolio and Resumer AI will read your
              skills, projects and experience from it.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <Link
                href="/import"
                className="inline-flex min-h-11 items-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
              >
                Import an existing resume
              </Link>
              <Link
                href="/settings/portfolio"
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-5 py-2.5 text-sm font-semibold hover:bg-paper"
              >
                Connect your portfolio
              </Link>
            </div>
          </div>
        ) : null}

        {flagged.length > 0 ? (
          <section className="mt-7 rounded-xl border border-warning bg-warning-tint/40 p-5">
            <h2 className="font-display text-lg text-warning">
              {flagged.length} item{flagged.length === 1 ? '' : 's'} no longer found in your
              portfolio
            </h2>
            <p className="mt-1.5 max-w-prose text-sm text-muted">
              These were pulled from your repo previously and have since disappeared from
              it. They haven&apos;t been deleted — a parsing miss shouldn&apos;t quietly cost you a
              piece of your history, so the decision is yours. Keeping one also makes it
              permanent: it becomes a manual record that syncs never touch again.
            </p>
            <ul className="mt-4 space-y-2">
              {flagged.map((r) => (
                <FlaggedRecord
                  key={r.id}
                  id={r.id}
                  type={TYPE_LABELS[r.type] ?? r.type}
                  text={describe(r.type, r.data)}
                />
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mt-7 space-y-5">
          {[...grouped.entries()].map(([type, list]) => (
            <section key={type} className="rounded-xl border border-line bg-surface p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display text-lg">{TYPE_LABELS[type] ?? type}</h2>
                <span className="font-mono text-xs text-muted tabular">{list.length}</span>
              </div>

              {type === 'skill' ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {list.map((r) => (
                    <span
                      key={r.id}
                      className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-medium text-brand-dark"
                      title={r.source === 'manual' ? 'Entered by hand' : 'From your portfolio'}
                    >
                      {describe(r.type, r.data)}
                    </span>
                  ))}
                </div>
              ) : (
                <ul className="mt-3 space-y-2">
                  {list.map((r) => (
                    <li key={r.id} className="flex items-start gap-2.5 text-sm">
                      <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-line" />
                      <span className="min-w-0">
                        {describe(r.type, r.data)}
                        <span className="ml-2 font-mono text-[11px] text-muted">
                          {r.source === 'manual' ? 'manual' : 'synced'}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
