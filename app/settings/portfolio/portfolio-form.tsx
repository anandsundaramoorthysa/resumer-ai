'use client';

import { useActionState, useState, useTransition } from 'react';
import Link from 'next/link';
import { connectRepo, syncNow, disconnectRepo, type ActionResult } from './actions';

export function PortfolioForm({
  currentRepo,
  lastSyncedAt,
  recordCount,
  syncedCount,
  flaggedCount,
}: {
  currentRepo: string | null;
  lastSyncedAt: string | null;
  recordCount: number;
  syncedCount: number;
  flaggedCount: number;
}) {
  const [connectState, connectAction, connecting] = useActionState<
    ActionResult | null,
    FormData
  >(connectRepo, null);

  const [syncResult, setSyncResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const runSync = () => {
    setSyncResult(null);
    startTransition(async () => setSyncResult(await syncNow()));
  };

  const runDisconnect = () => {
    setSyncResult(null);
    startTransition(async () => setSyncResult(await disconnectRepo()));
  };

  return (
    <div className="mt-6 space-y-5">
      <div className="rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg">
            {currentRepo ? 'Connected repository' : 'Connect a repository'}
          </h2>
          {currentRepo ? (
            <span className="rounded-full bg-success-tint px-2.5 py-1 text-xs font-semibold text-success">
              ✓ Connected
            </span>
          ) : null}
        </div>

        <form action={connectAction} className="mt-4">
          <label htmlFor="repo" className="text-sm font-medium">
            Repository
          </label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <input
              id="repo"
              name="repo"
              defaultValue={currentRepo ?? ''}
              placeholder="owner/name"
              className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-2.5 font-mono text-sm outline-none focus:border-brand"
            />
            <button
              type="submit"
              disabled={connecting}
              className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              {connecting ? 'Checking…' : currentRepo ? 'Update' : 'Connect'}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Private repositories work — your GitHub sign-in already granted the access.
            The connection is verified before it&apos;s saved.
          </p>
        </form>

        {connectState ? (
          <p
            className={`mt-3 rounded-lg px-3 py-2.5 text-sm ${
              connectState.ok
                ? 'bg-success-tint text-success'
                : 'bg-danger-tint text-danger'
            }`}
          >
            {connectState.message}
          </p>
        ) : null}
      </div>

      {currentRepo ? (
        <div className="rounded-xl border border-line bg-surface p-5">
          <h2 className="font-display text-lg">Sync</h2>
          <dl className="mt-3 text-sm">
            <Row k="Last checked" v={formatWhen(lastSyncedAt)} />
            <Row k="Profile facts" v={String(recordCount)} />
            <Row k="From your portfolio" v={String(syncedCount)} />
            {flaggedCount > 0 ? (
              <Row k="Awaiting your review" v={`${flaggedCount} flagged`} warn />
            ) : null}
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runSync}
              disabled={pending}
              className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              {pending ? 'Syncing…' : 'Sync now'}
            </button>
            {flaggedCount > 0 ? (
              <Link
                href="/profile"
                className="rounded-lg border border-warning px-4 py-2.5 text-sm font-semibold text-warning hover:bg-warning-tint"
              >
                Review {flaggedCount} flagged
              </Link>
            ) : (
              <Link
                href="/profile"
                className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold hover:bg-paper"
              >
                View profile
              </Link>
            )}
            <button
              type="button"
              onClick={runDisconnect}
              disabled={pending}
              className="rounded-lg px-4 py-2.5 text-sm font-semibold text-muted hover:text-danger disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>

          {syncResult ? (
            <p
              className={`mt-3 rounded-lg px-3 py-2.5 text-sm ${
                syncResult.ok ? 'bg-success-tint text-success' : 'bg-danger-tint text-danger'
              }`}
            >
              {syncResult.message}
            </p>
          ) : null}

          <p className="mt-3 text-xs text-muted">
            A sync also runs automatically before every draft, so this button is only for
            when you want to see the result right away.
          </p>
        </div>
      ) : null}
    </div>
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

function formatWhen(iso: string | null): string {
  if (!iso) return 'Never';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}
