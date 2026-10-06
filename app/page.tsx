import Link from 'next/link';
import { auth, isAuthConfigured } from '@/auth';
import { isDatabaseConfigured } from '@/lib/db';
import { isEncryptionConfigured } from '@/lib/auth/secret-box';
import { hasAnyProvider, availableProviders } from '@/lib/ai/models';
import { AppHeader } from '@/components/app-header';
import { DraftConsole } from '@/components/draft-console';
import { Landing } from '@/components/landing/landing';
import { SetupChecklist } from '@/components/setup-checklist';
import { getDashboardData } from '@/lib/server/dashboard';
import { approvalFor } from '@/lib/server/approval';
import { redirect } from 'next/navigation';

export const metadata = { alternates: { canonical: '/' } };

export default async function HomePage() {
  // TOKEN_ENC_KEY is part of "ready": the fit check in front of every draft seals its
  // result with it, so without the key the dashboard would offer a draft that always fails.
  const ready = isDatabaseConfigured && isAuthConfigured && hasAnyProvider() && isEncryptionConfigured();

  if (!ready) {
    return (
      <Shell>
        <SetupChecklist
          database={isDatabaseConfigured}
          auth={isAuthConfigured}
          encryption={isEncryptionConfigured()}
          providers={availableProviders().map((p) => p.label)}
        />
      </Shell>
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    return (
      <Shell>
        <Landing />
      </Shell>
    );
  }

  // Signed in is not the same as let in: a new account waits for the owner's approval.
  if ((await approvalFor(session.user.id)) !== 'approved') redirect('/pending');

  const data = await getDashboardData(session.user.id);
  const firstName = (session.user.name ?? 'there').split(' ')[0];

  // REQ-8.3 — a first-run user gets a next step, not an empty dashboard.
  if (data.recordCount === 0) {
    return (
      <Shell userName={session.user.name ?? undefined}>
        <div className="mx-auto max-w-2xl">
          <p className="eyebrow">§ 1 Get started</p>
          <h1 className="mt-2 font-display text-3xl tracking-tight">
            Let&apos;s get your profile in, {firstName}
          </h1>
          <p className="mt-3 max-w-prose text-base text-muted">
            Resumer AI builds every resume from facts you actually have, so it needs your
            profile before it can draft anything.
          </p>

          <section className="sheet mt-8 p-5 sm:p-6" aria-labelledby="next-step">
            <p className="eyebrow text-brand">Recommended next step</p>
            <h2 id="next-step" className="mt-1 font-display text-xl">
              Connect your GitHub portfolio
            </h2>
            <p className="mt-2 max-w-prose text-sm text-muted">
              Point it at the repo behind your site. It reads your skills, projects and
              experience, and re-checks for changes before every draft.
            </p>
            <Link href="/settings/portfolio" className="btn btn-primary mt-4">
              Connect GitHub portfolio
            </Link>
          </section>

          <p className="eyebrow mt-8">Or</p>
          <ul className="mt-2 divide-y divide-line border-y border-line text-sm">
            <li className="py-3">
              <Link href="/import" className="font-semibold underline">
                Upload an existing resume
              </Link>
              <span className="block text-muted">
                PDF or DOCX, read into individual facts and shown to you for approval first.
              </span>
            </li>
            <li className="py-3">
              <Link href="/profile" className="font-semibold underline">
                Add your details by hand
              </Link>
              <span className="block text-muted">
                Anything you enter is yours; the sync never overwrites it.
              </span>
            </li>
          </ul>

          <RadarCard className="mt-8" />
        </div>
      </Shell>
    );
  }

  return (
    <Shell userName={session.user.name ?? undefined}>
      <div className="mb-8">
        <p className="eyebrow">§ Dashboard</p>
        <h1 className="mt-2 font-display text-3xl tracking-tight">Good to see you, {firstName}</h1>
      </div>

      <dl className="mb-8 max-w-xl">
        <Leader label="Resumes drafted" value={String(data.draftCount)} />
        <Leader
          label={data.averageRole ? `Average ATS score · ${data.averageRole}` : 'Average ATS score'}
          value={data.averageScore ? `${data.averageScore.toFixed(1)} / 10` : 'None yet'}
        />
        <Leader label="Applications tracked" value={String(data.applicationCount)} />
        <Leader label="Profile last synced" value={data.lastSyncedLabel} />
      </dl>

      <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        {/*
          * `min-w-0` is load-bearing: a grid item's automatic minimum size is min-content,
          * so without it the Recent drafts table widens the layout viewport on a 320px
          * phone and the whole page scrolls sideways (and window.innerWidth/scrollWidth
          * both read the widened value, hiding it from overflow checks).
          */}
        <div className="min-w-0 space-y-8">
          <DraftConsole />
          <RecentDrafts drafts={data.recentDrafts} />
        </div>
        <div className="min-w-0 space-y-8">
          <RadarCard />
          <PortfolioCard
            repo={data.portfolioRepo}
            lastSyncedLabel={data.lastSyncedLabel}
            recordCount={data.recordCount}
            flaggedCount={data.flaggedCount}
          />
        </div>
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
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/" userName={userName} width="6xl" />
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-5 py-8">
        {children}
      </main>
    </div>
  );
}

/** Ledger row: label, dotted leader, value. */
function Leader({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 py-1.5">
      <dt className="min-w-0 text-sm text-muted">{label}</dt>
      <span aria-hidden="true" className="min-w-4 flex-1 border-b border-dotted border-rule" />
      <dd className="font-mono text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function RadarCard({ className = '' }: { className?: string }) {
  return (
    <section className={`sheet p-5 ${className}`} aria-labelledby="radar-h">
      <p className="eyebrow">§ Discover</p>
      <h2 id="radar-h" className="mt-1 font-display text-xl">
        Job Radar
      </h2>
      <p className="mt-2 text-sm text-muted">
        Live openings from Google Jobs (SerpApi), ranked against your real profile, with
        sources shown.
      </p>
      <Link href="/radar" className="btn mt-4">
        Open Job Radar
      </Link>
    </section>
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
    <section className="border-t border-line pt-4">
      <p className="eyebrow">§ Recent</p>
      <h2 className="font-display text-xl">Recent drafts</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="ledger text-sm">
          <thead>
            <tr>
              <th className="min-w-48">Role</th>
              <th>Category</th>
              <th>Score</th>
              <th>Drafted</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => (
              <tr key={d.id}>
                <td>
                  <div className="font-semibold">{d.roleTitle}</div>
                  {d.company ? <div className="text-xs text-muted">{d.company}</div> : null}
                </td>
                <td>
                  <span className="border border-rule px-1.5 py-0.5 text-xs font-semibold">
                    {d.category}
                  </span>
                </td>
                <td
                  /* "Not scored yet" and "scored badly" are different facts: unscored is muted. */
                  className={`font-mono font-semibold tabular-nums ${
                    d.score == null
                      ? 'text-muted'
                      : d.score >= 8.5
                        ? 'text-success'
                        : 'text-warning'
                  }`}
                >
                  {d.score?.toFixed(1) ?? '—'}
                </td>
                <td className="text-muted">{d.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
    <aside className="border-t border-line pt-4">
      <span
        className={`inline-flex items-center gap-1.5 border border-current px-2 py-0.5 text-xs font-semibold ${
          repo ? 'text-success' : 'text-warning'
        }`}
      >
        {repo ? '✓ Connected' : 'Not connected'}
      </span>
      <h2 className="mt-3 font-display text-lg">Portfolio connection</h2>

      <dl className="mt-3 text-sm">
        <Row k="Source" v={repo ?? 'None yet'} />
        <Row k="Last checked" v={lastSyncedLabel} />
        <Row k="Profile facts" v={String(recordCount)} />
        {flaggedCount > 0 ? <Row k="Needs review" v={`${flaggedCount} flagged`} warn /> : null}
      </dl>

      <Link href="/settings/portfolio" className="btn mt-4 w-full">
        {repo ? 'Manage connection' : 'Connect portfolio'}
      </Link>
    </aside>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dotted border-rule py-2 last:border-b-0">
      <dt className="text-muted">{k}</dt>
      <dd className={`font-semibold ${warn ? 'text-warning' : ''}`}>{v}</dd>
    </div>
  );
}
