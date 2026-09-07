'use client';

import { useTransition } from 'react';
import { setApplicationStatus, type ApplicationStatus } from './actions';

const OPTIONS: Array<{ value: ApplicationStatus; label: string }> = [
  { value: 'draft', label: 'Draft' },
  { value: 'applied', label: 'Applied' },
  { value: 'interview', label: 'Interview' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'offer', label: 'Offer' },
];

/** Status carries meaning, so it carries colour — scannable without reading. */
const TONE: Record<ApplicationStatus, string> = {
  // Draft is the neutral one — nothing has happened yet. Rejected is an outcome and
  // now reads as one: both were `border-muted text-muted`, which made the single pair
  // whose difference matters most the one pair you could not tell apart.
  draft: 'border-muted text-muted',
  applied: 'border-brand text-brand-dark',
  interview: 'border-gold text-gold',
  rejected: 'border-danger text-danger',
  offer: 'border-success text-success',
};

export function StatusSelect({
  id,
  status,
}: {
  id: string;
  status: ApplicationStatus;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <select
      value={status}
      disabled={pending}
      onChange={(e) =>
        startTransition(() =>
          setApplicationStatus(id, e.target.value as ApplicationStatus),
        )
      }
      className={`min-h-11 rounded-full border bg-surface px-2.5 py-1 text-xs font-semibold outline-none disabled:opacity-50 ${TONE[status]}`}
      aria-label="Application status"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
