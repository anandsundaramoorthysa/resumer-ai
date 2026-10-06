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
  interview: 'border-blue text-blue',
  rejected: 'border-danger text-danger',
  offer: 'border-success text-success',
};

export function StatusSelect({
  id,
  status,
  label,
}: {
  id: string;
  status: ApplicationStatus;
  /**
   * Which application this is. The page renders every row twice — a card list for phones
   * and a table above `sm` — so without it two controls carry the identical label
   * "Application status", and neither a screen reader nor a test can tell which row it is
   * on. (A browser test reaching for the first one found the hidden phone copy.)
   */
  label: string;
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
      className={`min-h-11 field !w-auto border-2 px-2.5 py-1 text-xs font-semibold disabled:opacity-50 ${TONE[status]}`}
      aria-label={`Status for ${label}`}
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
