'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { StatusSelect } from './status-select';
import type { ApplicationStatus } from './actions';

export type LedgerRow = {
  id: string;
  roleTitle: string;
  company: string | null;
  category: string;
  score: number | null;
  status: ApplicationStatus;
  createdAt: string; // ISO
  resumeSnapshotId: string;
};

type SortKey = 'roleTitle' | 'category' | 'score' | 'status' | 'createdAt';

const STATUSES: ApplicationStatus[] = ['draft', 'applied', 'interview', 'rejected', 'offer'];

// Fixed locale + zone so server and client render the same string.
const DATE_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const fmtDate = (iso: string) => DATE_FMT.format(new Date(iso));

const scoreTone = (s: number | null) =>
  s == null ? 'text-muted' : s >= 8.5 ? 'text-success' : 'text-warning';

const COLS: Array<{ key: SortKey; label: string }> = [
  { key: 'roleTitle', label: 'Role' },
  { key: 'category', label: 'Category' },
  { key: 'score', label: 'Score' },
  { key: 'status', label: 'Status' },
  { key: 'createdAt', label: 'Drafted' },
];

export function Ledger({ rows }: { rows: LedgerRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'createdAt',
    dir: 'desc',
  });
  const [filter, setFilter] = useState<'all' | ApplicationStatus>('all');

  const view = useMemo(() => {
    const list = rows.filter((r) => filter === 'all' || r.status === filter);
    const m = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // unscored always last
      if (bv == null) return -1;
      return (av < bv ? -1 : av > bv ? 1 : 0) * m;
    });
  }, [rows, sort, filter]);

  const toggle = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'score' || key === 'createdAt' ? 'desc' : 'asc' },
    );

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="status-filter" className="eyebrow">
          Filter by status
        </label>
        <select
          id="status-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as 'all' | ApplicationStatus)}
          className="field !w-auto"
        >
          <option value="all">All ({rows.length})</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)} ({rows.filter((r) => r.status === s).length})
            </option>
          ))}
        </select>
        <p role="status" className="font-mono text-xs text-muted">
          {view.length} of {rows.length} shown
        </p>
      </div>

      {view.length === 0 ? (
        <p className="mt-6 border-t border-line pt-4 text-sm text-muted">
          No applications with this status.
        </p>
      ) : (
        <>
          <ul className="mt-6 border-t border-line sm:hidden">
            {view.map((r) => (
              <li key={r.id} className="border-b border-line py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{r.roleTitle}</p>
                    {r.company ? <p className="mt-0.5 text-xs text-muted">{r.company}</p> : null}
                  </div>
                  <span
                    className={`flex-none font-mono text-lg font-semibold tabular ${scoreTone(r.score)}`}
                  >
                    {r.score?.toFixed(1) ?? '—'}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="border border-line px-2 py-1 font-mono text-xs uppercase tracking-wider">
                    {r.category}
                  </span>
                  <StatusSelect id={r.id} status={r.status} label={r.roleTitle} />
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="font-mono text-xs text-muted">{fmtDate(r.createdAt)}</span>
                  <Link
                    href={`/resume/${r.resumeSnapshotId}`}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center text-xs font-semibold text-brand-dark hover:underline"
                  >
                    Review<span className="sr-only"> {r.roleTitle}</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-6 hidden overflow-x-auto sm:block">
            <table className="ledger">
              <caption className="sr-only">
                Applications, one row per drafted resume. Use the column header buttons to sort.
              </caption>
              <thead>
                <tr>
                  {COLS.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={
                        sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                    >
                      <button
                        type="button"
                        onClick={() => toggle(c.key)}
                        className="inline-flex min-h-11 items-center gap-1 uppercase tracking-wider hover:text-ink"
                      >
                        {c.label}
                        <span aria-hidden="true">
                          {sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    </th>
                  ))}
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.map((r) => (
                  <tr key={r.id}>
                    <td className="min-w-56">
                      <div className="font-semibold">{r.roleTitle}</div>
                      {r.company ? <div className="text-xs text-muted">{r.company}</div> : null}
                    </td>
                    <td className="font-mono text-xs uppercase tracking-wider">{r.category}</td>
                    <td className={`font-mono font-semibold tabular ${scoreTone(r.score)}`}>
                      {r.score?.toFixed(1) ?? '—'}
                    </td>
                    <td>
                      <StatusSelect id={r.id} status={r.status} label={r.roleTitle} />
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs text-muted">
                      {fmtDate(r.createdAt)}
                    </td>
                    <td className="text-right">
                      <Link
                        href={`/resume/${r.resumeSnapshotId}`}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center text-xs font-semibold text-brand-dark hover:underline"
                      >
                        Review<span className="sr-only"> {r.roleTitle}</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
