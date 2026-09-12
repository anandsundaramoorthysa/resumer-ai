import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { requireApprovedUser } from '@/lib/server/approval';
import { db } from '@/lib/db';
import { profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { FlaggedRecord } from './flagged-record';
import { ProposedBulkControls, ProposedRecord } from './proposed-record';
import { EnrichmentControls, EnrichmentQuestion } from './enrichment-question';
import { loadEnrichmentQueue } from '@/lib/server/enrichment';
import { BulletEditor, type ExistingBullet } from './bullet-editor';
import { AddJob, JobHeader } from './role-editor';
import { RecordEditor, type EditableRecord } from './record-editor';
import { ProfileAssistant } from './profile-assistant';
import { RECORD_FORMS, describeRecord, formFor } from '@/lib/profile/forms';
import { findProfileGaps } from '@/lib/profile/gaps';
import { orderRecords } from '@/lib/profile/ordering';
import { rolesByRecency } from '@/lib/generate/assemble';
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
  const session = await requireApprovedUser();
  const userId = session.user.id;

  const records = await db
    .select()
    .from(profileRecords)
    .where(eq(profileRecords.userId, userId));
  const allRoles = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.userId, userId));

  /*
   * Three states, and the page has to keep them apart.
   *
   * `pending` is what the last sync proposed and nobody has accepted yet. It is not the
   * profile: `loadProfileForUser` will not hand it to a draft, so showing it in the
   * sections below would tell the user they have a fact that no resume can use. It gets
   * its own queue at the top instead.
   *
   * `rejected` rows are tombstones that keep sync from re-proposing a claim — see
   * lib/server/sync-review.ts. They are not shown anywhere; the user has already
   * answered.
   */
  const proposed = records.filter((r) => r.reviewState === 'pending');
  const decided = records.filter((r) => r.reviewState === 'approved');
  const roles = rolesByRecency(allRoles.filter((r) => r.reviewState === 'approved') as never) as typeof allRoles;
  const proposedRoles = allRoles.filter((r) => r.reviewState === 'pending');
  const reviewCount = proposed.length + proposedRoles.length;

  const flagged = decided.filter((r) => r.flaggedForRemoval);
  const active = decided.filter((r) => !r.flaggedForRemoval);

  /** Job labels for every role, proposed ones included, so a bullet can name its job. */
  const roleLabels = new Map(
    allRoles.map((r) => [r.id, `${r.title} — ${r.company}`] as const),
  );

  const proposedByType = new Map<string, typeof records>();
  for (const r of proposed) {
    const list = proposedByType.get(r.type) ?? [];
    list.push(r);
    proposedByType.set(r.type, list);
  }
  // Same order the rest of the page uses, bullets first because they follow the jobs
  // they belong to. Row order otherwise comes out of the database unsorted, so the queue
  // rearranges itself every time one item is decided.
  const reviewOrder = ['experience-bullet', ...SECTION_ORDER];
  const proposedSections = [...proposedByType.entries()].sort(
    (a, b) =>
      (reviewOrder.indexOf(a[0]) + 1 || 99) - (reviewOrder.indexOf(b[0]) + 1 || 99),
  );

  // The gap summary is the point of this page for a profile like this one: sync cannot
  // write accomplishments that the portfolio never stated, so the hole has to be visible
  // and typeable rather than merely absent from the resume (AUDIT.md #2, #5).
  /*
   * `tags` is not decoration here, and leaving it out was a real fault rather than a
   * shortcut. This object is cast to `ProfileRecord`, so the compiler stops asking what
   * is missing from it — and `profileVocabulary` (lib/quality/skills.ts), which decides
   * what the profile can legitimately claim, iterates exactly this field. The cast said
   * the field was there, the row said otherwise, and the first caller to read it crashed
   * the whole page with "r.tags is not iterable". `findProfileGaps` never touched it,
   * which is the only reason it survived this long.
   */
  const asRecords = active.map((r) => ({
    id: r.id,
    type: r.type,
    source: r.source,
    contentHash: r.contentHash,
    tags: r.tags ?? [],
    flaggedForRemoval: r.flaggedForRemoval,
    reviewState: r.reviewState,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
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

  /*
   * The questions the last draft could not answer for itself.
   *
   * Read after `asRecords` is built because the queue is filtered against the live
   * profile, not against what it stored: a gap closed in the bullet editor two sections
   * below takes its question with it, without anything having to tell the queue.
   */
  const queue = await loadEnrichmentQueue(userId, asRecords);

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
  // Rows arrive in whatever order Postgres returns them, which is the order they were
  // written: Experience read oldest-job-first and a school certificate sat above a
  // degree. Each section now uses the order its own kind is read in — see
  // lib/profile/ordering.ts, and rolesByRecency for the jobs themselves.
  for (const [type, list] of grouped) grouped.set(type, orderRecords(type, list));

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/profile" width="6xl" />

      <main className="mx-auto max-w-6xl px-5 py-8">
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

        {/* The steward's front door (STEWARD.md). First on the page, because it is the
            fastest way to both fill a thin profile and fix a full one. */}
        <ProfileAssistant empty={decided.length === 0} />

        {decided.length === 0 && reviewCount === 0 ? (
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

        {/*
          * The sync review queue.
          *
          * Above the flagged list on purpose: that one asks about facts already in the
          * profile, this one is the gate everything from the repository has to pass
          * before it is a fact at all. A repository is parsed by an LLM, and an LLM
          * reading a file that tells it to invent a job at Stripe invents a job at
          * Stripe — which every later check would then verify against, and pass. The
          * queue is the only place a person sees the claim before that happens.
          */}
        {reviewCount > 0 ? (
          <section className="mt-7 rounded-xl border border-gold bg-gold-tint/40 p-5">
            <h2 className="font-display text-lg text-gold">
              {reviewCount} new item{reviewCount === 1 ? '' : 's'} from your portfolio,
              waiting for you
            </h2>
            <p className="mt-1.5 max-w-prose text-sm text-muted">
              Your last sync read these out of your repository. They are not part of your
              profile yet and no resume can use them until you approve them — what a repo
              says is a proposal, and a resume is a claim you sign. Approving keeps a
              record in step with the repo on later syncs; rejecting is remembered, so a
              later sync will not offer the same item again. Approving a bullet also
              approves the job it belongs to.
            </p>

            <ProposedBulkControls count={reviewCount} />

            {proposedRoles.length > 0 ? (
              <div className="mt-5">
                <h3 className="text-sm font-semibold">Jobs</h3>
                <ul className="mt-2 space-y-2">
                  {proposedRoles.map((role) => (
                    <ProposedRecord
                      key={role.id}
                      id={role.id}
                      kind="role"
                      text={`${role.title} — ${role.company}`}
                      context={`${role.startDate || 'no start'} → ${role.endDate}`}
                    />
                  ))}
                </ul>
              </div>
            ) : null}

            {proposedSections.map(([type, list]) => (
              <div key={type} className="mt-5">
                <h3 className="text-sm font-semibold">{labelFor(type)}</h3>
                <ul className="mt-2 space-y-2">
                  {list.map((r) => (
                    <ProposedRecord
                      key={r.id}
                      id={r.id}
                      kind="record"
                      text={describeRecord(r.type, r.data as Record<string, unknown>)}
                      context={
                        r.type === 'experience-bullet'
                          ? roleLabels.get(
                              String((r.data as Record<string, unknown>).roleId ?? ''),
                            )
                          : undefined
                      }
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>
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

        {/*
          * The third queue, and the last of the three that asks something of you.
          *
          * Placed under the two reviews rather than beside the gap summary below,
          * because it belongs to the same family: all three are outstanding business
          * between you and the system, and all three empty by being answered. The
          * difference is what it costs — the reviews are a click each, this is a
          * sentence each — which is why only three show at a time.
          *
          * What separates it from the gap summary underneath is that the summary knows
          * only that a hole exists. These know which hole, on which line, and why the
          * last draft could not fill it: each one comes from a refused grounded rewrite,
          * the evidence grader's own words, or a keyword the posting demanded that
          * nothing in the profile evidences.
          */}
        {/*
          * Shown when the queue has something, and also when the user has turned it down
          * — otherwise `off` would hide the only control that undoes `off`.
          */}
        {queue.shown.length > 0 || queue.mode !== 'all' ? (
          <section className="mt-7 rounded-xl border border-brand bg-brand-tint/40 p-5">
            <h2 className="font-display text-lg text-brand-dark">
              {/*
                * Worded by mode, not by emptiness: `current-job` with nothing to ask used
                * to say the questions were "turned off", which the radio right below
                * contradicted.
                */}
              {queue.mode === 'off'
                ? 'Questions from your drafts are turned off'
                : queue.shown.length === 0
                  ? 'Nothing to ask about the job you are drafting for'
                  : `${queue.total} question${queue.total === 1 ? '' : 's'} from your last draft`}
            </h2>
            <p className="mt-1.5 max-w-prose text-sm text-muted">
              {queue.mode === 'off' ? (
                <>
                  Nothing is being asked. Drafts still record what they could not evidence,
                  so turning this back on brings the backlog back as it was.
                </>
              ) : queue.shown.length === 0 ? (
                <>
                  Your last draft found nothing only you could answer. Questions from earlier
                  drafts are kept; choose &ldquo;Ask me anything&rdquo; to see them.
                </>
              ) : (
                <>
                  Each of these is a fact your resume needed and only you have. Nothing here
                  will guess one for you — that is the whole point — so the draft stopped and
                  wrote down what it was missing instead. Answering one takes a sentence, and
                  what you type is stored word for word as your own record: a sync will never
                  overwrite it, and every later draft can use it.
                </>
              )}
              {queue.total > queue.shown.length
                ? ` Showing the ${queue.shown.length} with the most effect on your score; the other ${
                    queue.total - queue.shown.length
                  } appear as you clear these.`
                : ''}
            </p>
            <ul className="mt-4 space-y-3">
              {queue.shown.map((q) => (
                <EnrichmentQuestion
                  key={q.id}
                  question={{
                    id: q.id,
                    kind: q.kind,
                    topic: q.topic,
                    quote: q.quote,
                    context: q.context,
                    reason: q.reason,
                    missing: q.missing,
                  }}
                />
              ))}
            </ul>
            <EnrichmentControls mode={queue.mode} />
          </section>
        ) : null}

        {gaps.headline ? (
          <section className="mt-7 rounded-xl border border-warning bg-warning-tint/40 p-5">
            <h2 className="font-display text-lg text-warning">{gaps.headline}</h2>
            <p className="mt-1.5 max-w-prose text-sm text-muted">
              These are facts only you have. Your portfolio states what you worked on but
              not what changed as a result, and nothing here will invent that — so a role
              with nothing recorded simply cannot appear on a resume. Generate a draft and
              the pipeline will turn the ones that actually cost you marks into specific
              questions, above.
            </p>
          </section>
        ) : null}

        {/* Always rendered: with no jobs yet, this is where the first one is added. */}
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
                const job = {
                  id: role.id,
                  title: role.title,
                  company: role.company,
                  location: role.location ?? null,
                  startDate: role.startDate,
                  endDate: role.endDate,
                };
                return (
                  <div key={role.id} className="border-t border-line pt-4 first:border-t-0 first:pt-0">
                    <JobHeader
                      job={job}
                      bulletCount={bullets.length}
                      others={roles
                        .filter((r) => r.id !== role.id)
                        .map((r) => ({ id: r.id, title: r.title, company: r.company, location: r.location ?? null, startDate: r.startDate, endDate: r.endDate }))}
                    />
                    <BulletEditor
                      roleId={role.id}
                      roleLabel={role.company}
                      bullets={bullets}
                    />
                  </div>
                );
              })}
            </div>
            <AddJob />
          </section>

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
                {/* Two columns from `sm`, three from `lg`. This block is a list of
                    "add one of these" stubs — a heading and a small form each — and in
                    the wider shell two columns left each one about 550px wide for a
                    control that needs nothing like it. Three keeps the stubs at a
                    sensible size and shortens the block, which matters because it sits
                    at the very bottom of an already long page. */}
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
