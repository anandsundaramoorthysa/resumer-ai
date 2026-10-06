'use client';

import { useActionState, useState, useTransition } from 'react';
import Link from 'next/link';
import { connectRepo, disconnectRepo, type ActionResult } from './actions';

interface StepState {
  jobId: string;
  step: number;
  totalSteps: number;
  status: 'running' | 'done' | 'error';
  message: string;
  done: boolean;
  error?: string;
}

export function PortfolioForm({
  currentRepo,
  lastSyncedAt,
  recordCount,
  syncedCount,
  flaggedCount,
  pendingCount,
}: {
  currentRepo: string | null;
  lastSyncedAt: string | null;
  recordCount: number;
  syncedCount: number;
  flaggedCount: number;
  /** New claims the last sync proposed that nobody has accepted yet. */
  pendingCount: number;
}) {
  const [connectState, connectAction, connecting] = useActionState<
    ActionResult | null,
    FormData
  >(connectRepo, null);

  const [syncResult, setSyncResult] = useState<ActionResult | null>(null);
  const [progress, setProgress] = useState<StepState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, startTransition] = useTransition();

  /**
   * Drives the sync one step per request. Reading a portfolio takes minutes, which no
   * serverless function will hold open — stepping it keeps every request short and
   * turns the wait into visible progress instead of a spinner that may just die.
   */
  const runSync = async () => {
    setSyncResult(null);
    setSyncing(true);
    try {
      let state: StepState | null = null;
      for (let guard = 0; guard < 40; guard++) {
        const res = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state ? { jobId: state.jobId } : {}),
        });
        // A step killed at the host's time limit answers with an HTML page, not JSON.
        const json = await res.json().catch(() => null);
        if (!res.ok || !json) {
          setSyncResult({ ok: false, message: json?.error ?? 'That sync step did not finish. Run the sync again — it carries on where it stopped.' });
          return;
        }
        state = json as StepState;
        setProgress(state);
        if (state.done) {
          setSyncResult({
            ok: state.status === 'done',
            message: state.error ?? state.message,
          });
          if (state.status === 'done') window.location.reload();
          return;
        }
      }
      setSyncResult({ ok: false, message: 'Sync took too many steps and was stopped.' });
    } catch {
      setSyncResult({ ok: false, message: 'The connection dropped. Run the sync again — it carries on where it stopped.' });
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  };

  const runDisconnect = () => {
    setSyncResult(null);
    startTransition(async () => setSyncResult(await disconnectRepo()));
  };

  return (
    <div className="mt-6 space-y-5">
      <div className="border-t border-line pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg">
            {currentRepo ? 'Connected repository' : 'Connect a repository'}
          </h2>
          {currentRepo ? (
            <span className="bg-success-tint px-2.5 py-1 text-xs font-semibold text-success">
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
              className="field min-w-0 flex-1 font-mono"
            />
            <button
              type="submit"
              disabled={connecting}
              className="btn btn-primary text-sm"
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
            className={`mt-3 px-3 py-2.5 text-sm ${
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
        <div className="border-t border-line pt-4">
          <h2 className="font-display text-lg">Sync</h2>
          <dl className="mt-3 text-sm">
            <Row k="Last checked" v={formatWhen(lastSyncedAt)} />
            <Row k="Profile facts" v={String(recordCount)} />
            <Row k="From your portfolio" v={String(syncedCount)} />
            {pendingCount > 0 ? (
              <Row k="Waiting for approval" v={`${pendingCount} new`} warn />
            ) : null}
            {flaggedCount > 0 ? (
              <Row k="Awaiting your review" v={`${flaggedCount} flagged`} warn />
            ) : null}
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runSync}
              disabled={pending || syncing}
              className="btn btn-primary text-sm"
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
            {pendingCount > 0 ? (
              <Link
                href="/profile"
                className="btn text-sm !border-blue"
              >
                Approve {pendingCount} new
              </Link>
            ) : null}
            {flaggedCount > 0 ? (
              <Link
                href="/profile"
                className="btn text-sm !border-warning"
              >
                Review {flaggedCount} flagged
              </Link>
            ) : (
              <Link
                href="/profile"
                className="btn inline-flex text-sm"
              >
                View profile
              </Link>
            )}
            <button
              type="button"
              onClick={runDisconnect}
              disabled={pending}
              className="min-h-11 px-4 py-2.5 text-sm font-semibold text-muted hover:text-danger disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>

          {progress && !progress.done ? (
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-muted">
                <span>{progress.message}</span>
                <span className="font-mono tabular">
                  {progress.step}/{progress.totalSteps}
                </span>
              </div>
              <div
                className="progress mt-1.5"
                role="progressbar"
                aria-label="Sync progress"
                aria-valuemin={0}
                aria-valuemax={progress.totalSteps}
                aria-valuenow={progress.step}
                aria-valuetext={`${progress.message}, step ${progress.step} of ${progress.totalSteps}`}
              >
                <div
                  className="transition-[width]"
                  style={{ width: `${(progress.step / progress.totalSteps) * 100}%` }}
                />
              </div>
            </div>
          ) : null}

          {syncResult ? (
            <p
              className={`mt-3 px-3 py-2.5 text-sm ${
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
    <div className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0">
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
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
}
