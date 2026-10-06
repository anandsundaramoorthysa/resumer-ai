'use client';

/**
 * Adding, correcting and removing jobs.
 *
 * Jobs used to be read-only here: the importers and the sync were their only writers, so a
 * misspelt company, a missing start date or a second copy an import created stayed on the
 * profile — and on every resume — for good. Removing a job offers to move its
 * accomplishments to another job, which is how two copies of one job become one.
 */

import { useState, useTransition } from 'react';
import { removeJob, saveJob, type JobValues, type Result } from './record-actions';

export interface EditableJob {
  id: string;
  title: string;
  company: string;
  location: string | null;
  startDate: string;
  endDate: string;
}

const inputClass =
  'field mt-1';

export function JobHeader({ job, others, bulletCount }: { job: EditableJob; others: EditableJob[]; bulletCount: number }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  const [result, setResult] = useState<Result | null>(null);

  if (mode === 'edit') {
    return (
      <JobForm
        job={job}
        onDone={(r) => {
          setResult(r);
          if (r.ok) setMode('view');
        }}
        onCancel={() => setMode('view')}
      />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">
          {job.title}
          <span className="font-normal text-muted"> — {job.company}</span>
        </p>
        <span className="flex flex-wrap items-center gap-1">
          <span className={`font-mono text-xs ${job.startDate ? 'text-muted' : 'text-warning'}`}>
            {job.startDate || '(no start date)'} → {job.endDate}
            {job.location ? ` · ${job.location}` : ''}
          </span>
          <button
            type="button"
            onClick={() => setMode('edit')}
            className="min-h-11 px-3 text-xs font-semibold text-brand-dark hover:bg-paper"
          >
            Edit job
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === 'remove' ? 'view' : 'remove')}
            className="min-h-11 px-2.5 text-xs font-semibold text-danger hover:bg-danger-tint"
          >
            Remove job
          </button>
        </span>
      </div>
      {mode === 'remove' ? (
        <RemoveJob job={job} others={others} bulletCount={bulletCount} onDone={setResult} onCancel={() => setMode('view')} />
      ) : null}
      {result ? (
        <p className={`mt-1 text-xs ${result.ok ? 'text-success' : 'text-danger'}`} role="status">
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

export function AddJob() {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  return (
    <div className="mt-4">
      {open ? (
        <JobForm
          onDone={(r) => {
            setResult(r);
            if (r.ok) setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn text-sm"
        >
          + Add a job
        </button>
      )}
      {result ? (
        <p className={`mt-2 text-xs ${result.ok ? 'text-success' : 'text-danger'}`} role="status">
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

function JobForm({ job, onDone, onCancel }: { job?: EditableJob; onDone: (r: Result) => void; onCancel: () => void }) {
  const [values, setValues] = useState<JobValues>({
    title: job?.title ?? '',
    company: job?.company ?? '',
    location: job?.location ?? '',
    startDate: job?.startDate ?? '',
    endDate: job?.endDate && job.endDate !== 'present' ? job.endDate : '',
  });
  const [current, setCurrent] = useState(!job || job.endDate === 'present');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (key: keyof JobValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await saveJob(job?.id ?? null, { ...values, endDate: current ? 'present' : values.endDate }).catch(
        () => ({ ok: false, message: 'That could not be saved. Check your connection and try again.' }),
      );
      if (r.ok) onDone(r);
      else setError(r.message);
    });
  };

  return (
    <form onSubmit={submit} className="border border-brand-tint bg-paper p-3.5">
      <div className="grid gap-x-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-muted">Job title</span>
          <input required value={values.title} onChange={set('title')} className={inputClass} placeholder="Software Engineer" />
        </label>
        <label className="mt-2 block sm:mt-0">
          <span className="text-xs font-medium text-muted">Company</span>
          <input required value={values.company} onChange={set('company')} className={inputClass} placeholder="Acme" />
        </label>
        <label className="mt-2 block">
          <span className="text-xs font-medium text-muted">Started</span>
          <input
            required
            value={values.startDate}
            onChange={set('startDate')}
            className={inputClass}
            placeholder="2022-06, or 2022"
            inputMode="numeric"
          />
        </label>
        <label className="mt-2 block">
          <span className="text-xs font-medium text-muted">Ended</span>
          <input
            value={current ? '' : values.endDate}
            onChange={set('endDate')}
            disabled={current}
            required={!current}
            className={`${inputClass} disabled:opacity-50`}
            placeholder={current ? 'Current job' : '2024-03, or 2024'}
            inputMode="numeric"
          />
        </label>
        <label className="mt-2 flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={current} onChange={(e) => setCurrent(e.target.checked)} className="accent-brand" />
          I work here now
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-medium text-muted">Location (optional)</span>
          <input value={values.location} onChange={set('location')} className={inputClass} placeholder="Chennai, or Remote" />
        </label>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary text-sm"
        >
          {pending ? 'Saving…' : job ? 'Save job' : 'Add job'}
        </button>
        <button type="button" onClick={onCancel} className="min-h-11 px-4 text-sm font-semibold text-muted hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}

function RemoveJob({
  job,
  others,
  bulletCount,
  onDone,
  onCancel,
}: {
  job: EditableJob;
  others: EditableJob[];
  bulletCount: number;
  onDone: (r: Result) => void;
  onCancel: () => void;
}) {
  const [moveTo, setMoveTo] = useState('');
  const [pending, startTransition] = useTransition();
  const confirm = () =>
    startTransition(async () =>
      onDone(await removeJob(job.id, moveTo || null).catch(() => ({ ok: false, message: 'That could not be removed. Try again.' }))),
    );

  return (
    <div className="mt-2 border border-danger bg-danger-tint/40 p-3.5 text-sm">
      <p>
        Remove <strong>{job.title}</strong> at {job.company}
        {bulletCount > 0 ? ` and decide what happens to its ${bulletCount} accomplishment${bulletCount === 1 ? '' : 's'}` : ''}?
      </p>
      {bulletCount > 0 ? (
        <label className="mt-2 block">
          <span className="text-xs font-medium text-muted">Its accomplishments</span>
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className={inputClass}>
            <option value="">Remove them too</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                Move them to {o.title} — {o.company}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={pending}
          className="btn text-sm !border-danger !text-danger"
        >
          {pending ? 'Removing…' : 'Remove job'}
        </button>
        <button type="button" onClick={onCancel} className="min-h-11 px-4 text-sm font-semibold text-muted hover:text-ink">
          Keep it
        </button>
      </div>
    </div>
  );
}
