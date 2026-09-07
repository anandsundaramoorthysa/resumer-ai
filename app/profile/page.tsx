import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { FlaggedRecord } from './flagged-record';
import { BulletEditor, type ExistingBullet } from './bullet-editor';
import { RecordEditor, type EditableRecord } from './record-editor';
import { RECORD_FORMS, describeRecord, formFor } from '@/lib/profile/forms';
import { findProfileGaps } from '@/lib/profile/gaps';
import type { ProfileRecord, RoleRecord } from '@/lib/types';

export const metadata = { title: 'Profile' };
export const dynamic = 'force-dynamic';

/**
 * The order sections appear in. Everything editable is listed, including types the
 * profile has nothing of yet — an absent section is indistinguishable from a section
 * with no way to fill it, and the gaps here are exactly what the user is meant to fill.
 */
const SECTION_ORDER = [
  'summary',
  'skill',
  'project',
  'education',
  'certification',
  'publication',
  'writing',
  'award',
  'achievement',
  'volunteering',
  'language',
  'interest',
];

/** Types shown as chips: a bulleted list of single words reads far longer than it is. */
const CHIP_TYPES = new Set(['skill', 'language', 'interest']);

const EXTRA_LABELS: Record<string, string> = {
  'experience-bullet': 'Experience bullets',
};

function labelFor(type: string): string {
  return formFor(type)?.plural ?? EXTRA_LABELS[type] ?? type;
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
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/profile" width="4xl" />

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
              {/* The third route, which the dashboard's first-run card already promises
                  by name ("Add your details by hand") and which used to lead nowhere,
                  because every section was hidden while the profile was empty. */}
              <a
                href="#sections"
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-5 py-2.5 text-sm font-semibold hover:bg-paper"
              >
                Add your details by hand
              </a>
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
                  type={labelFor(r.type)}
                  text={describeRecord(r.type, r.data as Record<string, unknown>)}
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

        {/* A profile with nothing in it gets the invitation above instead of twelve
            empty forms, which read as work to do rather than a place to start. */}
        {/*
          * Sections that hold something get a card. The rest share one.
          *
          * Every type used to render a full bordered card whether or not it held
          * anything, so a realistic profile showed five identical "Nothing recorded yet"
          * cards in a row and ran to 2,955px on a desktop for twelve facts — the content
          * you have outnumbered by the content you do not.
          *
          * The whole block also used to be hidden while the profile was empty, which
          * broke the dashboard's own first-run card: it links here promising "Add your
          * details by hand" and landed on a page with no way to do that.
          */}
        <div id="sections" className="mt-7 space-y-5">
          {SECTION_ORDER.filter((type) => (grouped.get(type) ?? []).length > 0).map((type) => {
            const form = RECORD_FORMS[type];
            const list: EditableRecord[] = (grouped.get(type) ?? []).map((r) => ({
              id: r.id,
              source: r.source,
              data: r.data as Record<string, unknown>,
            }));

            return (
              <section key={type} className="rounded-xl border border-line bg-surface p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="font-display text-lg">{form.plural}</h2>
                  <span className="font-mono text-xs text-muted tabular">{list.length}</span>
                </div>
                <RecordEditor
                  type={type}
                  records={list}
                  chips={CHIP_TYPES.has(type)}
                  single={type === 'summary'}
                />
              </section>
            );
          })}

          {(() => {
            const empty = SECTION_ORDER.filter((type) => (grouped.get(type) ?? []).length === 0);
            if (empty.length === 0) return null;
            return (
              <section className="rounded-xl border border-dashed border-line p-5">
                <h2 className="font-display text-lg">Add something else</h2>
                <p className="mt-1 max-w-prose text-sm text-muted">
                  Nothing recorded under these yet. Anything you add here is yours — a
                  sync will never overwrite it.
                </p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {empty.map((type) => (
                    <div key={type}>
                      <h3 className="text-sm font-semibold">{RECORD_FORMS[type].plural}</h3>
                      <RecordEditor
                        type={type}
                        records={[]}
                        chips={CHIP_TYPES.has(type)}
                        single={type === 'summary'}
                        compact
                      />
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

          {/* Anything synced whose type predates the registry still has to be visible,
              even though there is no form for it yet. */}
          {[...grouped.entries()]
            .filter(([type]) => type !== 'experience-bullet' && !RECORD_FORMS[type])
            .map(([type, list]) => (
              <section key={type} className="rounded-xl border border-line bg-surface p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="font-display text-lg">{labelFor(type)}</h2>
                  <span className="font-mono text-xs text-muted tabular">{list.length}</span>
                </div>
                <ul className="mt-3 space-y-2">
                  {list.map((r) => (
                    <li key={r.id} className="text-sm">
                      {describeRecord(r.type, r.data as Record<string, unknown>)}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      </main>
    </div>
  );
}
