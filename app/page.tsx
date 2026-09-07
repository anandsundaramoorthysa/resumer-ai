import Link from 'next/link';
import { auth, isAuthConfigured } from '@/auth';
import { isDatabaseConfigured } from '@/lib/db';
import { hasAnyProvider, availableProviders } from '@/lib/ai/models';
import { AppHeader } from '@/components/app-header';
import { DraftConsole } from '@/components/draft-console';
import { SetupChecklist } from '@/components/setup-checklist';
import { getDashboardData } from '@/lib/server/dashboard';

export default async function HomePage() {
  const ready = isDatabaseConfigured && isAuthConfigured && hasAnyProvider();

  if (!ready) {
    return (
      <Shell>
        <SetupChecklist
          database={isDatabaseConfigured}
          auth={isAuthConfigured}
          providers={availableProviders().map((p) => p.label)}
        />
      </Shell>
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    return (
      <Shell>
        <div className="mx-auto max-w-lg rounded-2xl border border-line bg-surface p-8 text-center">
          <h1 className="font-display text-3xl">One profile. Every role.</h1>
          <p className="mt-3 text-sm text-muted">
            Sign in with GitHub to connect your portfolio and start drafting. The same
            sign-in grants the repo access used to keep your profile current, so there is
            no separate token to manage.
          </p>
          <Link
            href="/sign-in"
            className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
          >
            Sign in with GitHub
          </Link>
        </div>
      </Shell>
    );
  }

  const data = await getDashboardData(session.user.id);
  const firstName = (session.user.name ?? 'there').split(' ')[0];

  // REQ-8.3 — a first-run user gets a next step, not an empty dashboard.
  if (data.recordCount === 0) {
    return (
      <Shell userName={session.user.name ?? undefined}>
        <div className="mx-auto max-w-xl rounded-2xl border border-line bg-surface p-8">
          <h1 className="font-display text-2xl">Let&apos;s get your profile in, {firstName}</h1>
          <p className="mt-2 text-sm text-muted">
            Resumer AI builds every resume from facts you actually have, so it needs your
            profile before it can draft anything. Two ways to fill it in a couple of
            minutes:
          </p>
          <div className="mt-6 space-y-3">
            <Link
              href="/settings/portfolio"
              className="block rounded-xl border border-line p-4 transition-colors hover:border-brand"
            >
              <div className="font-semibold">Connect your GitHub portfolio</div>
              <div className="mt-1 text-sm text-muted">
                Point it at the repo behind your site. It reads your skills, projects and
                experience, and re-checks for changes before every draft.
              </div>
            </Link>
            <Link
              href="/import"
              className="block rounded-xl border border-line p-4 transition-colors hover:border-brand"
            >
              <div className="font-semibold">Upload an existing resume</div>
              <div className="mt-1 text-sm text-muted">
                PDF or DOCX. It&apos;s read into the individual facts behind it and shown to
                you for approval before anything is saved.
              </div>
            </Link>
            <Link
              href="/profile"
              className="block rounded-xl border border-line p-4 transition-colors hover:border-brand"
            >
              <div className="font-semibold">Add your details by hand</div>
              <div className="mt-1 text-sm text-muted">
                Skills, roles and projects. Anything you enter here is yours — the sync
                never overwrites it.
              </div>
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell userName={session.user.name ?? undefined}>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl">Good to see you, {firstName}</h1>
          <p className="mt-1 text-sm text-muted">Here&apos;s where things stand.</p>
        </div>
      </div>

      <dl className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Resumes drafted" value={String(data.draftCount)} />
        {/*
          * "None yet" rather than an em-dash.
          *
          * At 24px in a monospace face, accented with the dark theme's LIGHT teal, a bare
          * "—" rendered as a solid teal bar exactly where a number should be — beside
          * three tiles showing real values it read as a skeleton loader, not as "no data".
          * The accent is dropped when there is nothing to accent, matching the
          * "Profile last synced / Never" tile which already handled this correctly.
          */}
        <Stat
          label="Average ATS score"
          value={data.averageScore ? data.averageScore.toFixed(1) : 'None yet'}
          suffix={data.averageScore ? '/ 10' : undefined}
          accent={data.averageScore ? 'brand' : undefined}
          small={!data.averageScore}
        />
        <Stat label="Applications tracked" value={String(data.applicationCount)} />
        <Stat
          label="Profile last synced"
          value={data.lastSyncedLabel}
          accent="gold"
          small
        />
      </dl>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          <DraftConsole />
          <RecentDrafts drafts={data.recentDrafts} />
        </div>
        <PortfolioCard
          repo={data.portfolioRepo}
          lastSyncedLabel={data.lastSyncedLabel}
          recordCount={data.recordCount}
          flaggedCount={data.flaggedCount}
        />
      </div>
    </Shell>
  );
}

function Shell({
  children,
  userName,
}: {
  children: React.ReactNode;
  userName?: string;
}) {
  return (
    <div className="min-h-screen">
      <AppHeader current="/" userName={userName} width="6xl" />
      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  accent,
  small,
}: {
  label: string;
  value: string;
  suffix?: string;
  accent?: 'brand' | 'gold';
  small?: boolean;
}) {
  const color =
    accent === 'brand' ? 'text-brand-dark' : accent === 'gold' ? 'text-gold' : '';
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd
        className={`mt-1.5 font-mono font-semibold tabular ${
          small ? 'text-base' : 'text-2xl'
        } ${color}`}
      >
        {value}
        {suffix ? <span className="text-sm text-muted"> {suffix}</span> : null}
      </dd>
    </div>
  );
}

function RecentDrafts({
  drafts,
}: {
  drafts: Array<{
    id: string;
    roleTitle: string;
    company: string;
    category: string;
    score: number | null;
    createdAt: string;
  }>;
}) {
  if (drafts.length === 0) return null;

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="font-display text-xl">Recent drafts</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className="pb-2.5 pr-3 font-medium">Role</th>
              <th className="pb-2.5 pr-3 font-medium">Category</th>
              <th className="pb-2.5 pr-3 font-medium">Score</th>
              <th className="pb-2.5 font-medium">Drafted</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => (
              <tr key={d.id} className="border-t border-line">
                <td className="py-3 pr-3">
                  <div className="font-semibold">{d.roleTitle}</div>
                  {d.company ? (
                    <div className="text-xs text-muted">{d.company}</div>
                  ) : null}
                </td>
                <td className="py-3 pr-3">
                  <span className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand-dark">
                    {d.category}
                  </span>
                </td>
                <td
                  className={`py-3 pr-3 font-mono font-semibold tabular ${
                    (d.score ?? 0) >= 8.5 ? 'text-success' : 'text-warning'
                  }`}
                >
                  {d.score?.toFixed(1) ?? '—'}
                </td>
                <td className="py-3 text-muted">{d.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PortfolioCard({
  repo,
  lastSyncedLabel,
  recordCount,
  flaggedCount,
}: {
  repo: string | null;
  lastSyncedLabel: string;
  recordCount: number;
  flaggedCount: number;
}) {
  return (
    <aside className="rounded-2xl border border-line bg-surface p-5">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
          repo ? 'bg-success-tint text-success' : 'bg-warning-tint text-warning'
        }`}
      >
        {repo ? '✓ Connected' : 'Not connected'}
      </span>
      <h2 className="mt-3 font-display text-lg">Portfolio connection</h2>

      <dl className="mt-3 text-sm">
        <Row k="Source" v={repo ?? 'None yet'} />
        <Row k="Last checked" v={lastSyncedLabel} />
        <Row k="Profile facts" v={String(recordCount)} />
        {flaggedCount > 0 ? (
          <Row k="Needs review" v={`${flaggedCount} flagged`} warn />
        ) : null}
      </dl>

      <Link
        href="/settings/portfolio"
        className="mt-4 flex min-h-11 items-center justify-center rounded-lg border border-line py-2.5 text-center text-sm font-semibold hover:bg-paper"
      >
        {repo ? 'Manage connection' : 'Connect portfolio'}
      </Link>
    </aside>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dashed border-line py-2 last:border-b-0">
      <dt className="text-muted">{k}</dt>
      <dd className={`font-semibold ${warn ? 'text-warning' : ''}`}>{v}</dd>
    </div>
  );
}
