import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { Logo } from '@/components/logo';
import { FlaggedRecord } from './flagged-record';
import { BulletEditor, type ExistingBullet } from './bullet-editor';
import { findProfileGaps } from '@/lib/profile/gaps';
import type { ProfileRecord, RoleRecord } from '@/lib/types';

export const metadata = { title: 'Profile' };
export const dynamic = 'force-dynamic';

/**
 * Every record type needs an entry here and a case in `describe()`. A type missing from
 * either does not fail — it renders as a raw JSON blob under a heading like
 * "volunteering", which is how a synced record becomes invisible to the person who is
 * supposed to be reviewing it.
 */
const TYPE_LABELS: Record<string, string> = {
  summary: 'Professional summary',
  skill: 'Skills',
  'experience-bullet': 'Experience bullets',
  project: 'Projects',
  education: 'Education',
  certification: 'Certifications',
  publication: 'Publications',
  writing: 'Articles & writing',
  award: 'Awards',
  achievement: 'Achievements',
  volunteering: 'Volunteering & leadership',
  language: 'Languages',
  interest: 'Interests',
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
    case 'summary':
      return s('text');
    case 'publication':
      // Status is shown only when it isn't "published", so the line never implies a
      // paper is out when the record says it is still under review.
      return [
        s('title'),
        s('venue'),
        s('date'),
        s('doi') ? `DOI ${s('doi')}` : '',
        s('status') && s('status') !== 'published' ? s('status') : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'writing':
      return [s('title'), s('venue'), s('date')].filter(Boolean).join(' · ');
    case 'award':
      return [s('title'), s('issuer'), s('date')].filter(Boolean).join(' · ');
    case 'volunteering':
      return [s('role'), s('organization'), s('date')].filter(Boolean).join(' · ');
    case 'language':
      return s('proficiency') ? `${s('name')} — ${s('proficiency')}` : s('name');
    case 'interest':
      return s('name');
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

  // The gap summary is the point of this page for a profile like this one: sync cannot
  // write accomplishments that the portfolio never stated, so the hole has to be visible
  // and typeable rather than merely absent from the resume (AUDIT.md #2, #5).
  const asRecords = active.map((r) => ({
    id: r.id,
    type: r.type,
    flaggedForRemoval: r.flaggedForRemoval,
    ...(r.data as Record<string, unknown>),
  })) as unknown as ProfileRecord[];

  const asRoles = roles.map((r) => ({
    id: r.id,
    title: r.title,
    company: r.company,
    startDate: r.startDate,
    endDate: r.endDate,
  })) as unknown as RoleRecord[];

  const gaps = findProfileGaps(asRoles, asRecords);

  const bulletsByRole = new Map<string, ExistingBullet[]>();
  for (const r of active) {
    if (r.type !== 'experience-bullet') continue;
    const d = r.data as Record<string, unknown>;
    const roleId = String(d.roleId ?? '');
    const list = bulletsByRole.get(roleId) ?? [];
    list.push({
      id: r.id,
      action: String(d.action ?? ''),
      scale: d.scale ? String(d.scale) : undefined,
      outcome: d.outcome ? String(d.outcome) : undefined,
      text: String(d.text ?? ''),
    });
    bulletsByRole.set(roleId, list);
  }

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

        {gaps.headline ? (
          <section className="mt-7 rounded-xl border border-warning bg-warning-tint/40 p-5">
            <h2 className="font-display text-lg text-warning">{gaps.headline}</h2>
            <p className="mt-1.5 max-w-prose text-sm text-muted">
              These are facts only you have. Your portfolio states what you worked on but
              not what changed as a result, and nothing here will invent that — so a role
              with nothing recorded simply cannot appear on a resume.
            </p>
          </section>
        ) : null}

        {roles.length > 0 ? (
          <section className="mt-5 rounded-xl border border-line bg-surface p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-display text-lg">Experience</h2>
              <span className="font-mono text-xs text-muted tabular">
                {roles.length} role{roles.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="mt-4 space-y-6">
              {roles.map((role) => {
                const bullets = bulletsByRole.get(role.id) ?? [];
                return (
                  <div key={role.id} className="border-t border-line pt-4 first:border-t-0 first:pt-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-semibold">
                        {role.title}
                        <span className="font-normal text-muted"> — {role.company}</span>
                      </p>
                      <span className="font-mono text-xs text-muted">
                        {role.startDate || '(no start)'} → {role.endDate}
                        {role.location ? ` · ${role.location}` : ''}
                      </span>
                    </div>
                    <BulletEditor
                      roleId={role.id}
                      roleLabel={role.company}
                      bullets={bullets}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="mt-7 space-y-5">
          {[...grouped.entries()].filter(([type]) => type !== 'experience-bullet').map(([type, list]) => (
            <section key={type} className="rounded-xl border border-line bg-surface p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display text-lg">{TYPE_LABELS[type] ?? type}</h2>
                <span className="font-mono text-xs text-muted tabular">{list.length}</span>
              </div>

              {/* Chips for the one-word types; a bulleted list of single words reads
                  as a much longer section than it is. */}
              {type === 'skill' || type === 'language' || type === 'interest' ? (
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
