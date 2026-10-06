'use client';

/**
 * The review queue for what a sync proposed.
 *
 * Built to sit directly beneath the flagged-record list and read as the same kind of
 * thing: one row per item, the item's own words, two buttons. The only reason it is a
 * separate component is that it asks the opposite question — "is this yours?" rather
 * than "is this still yours?" — and answers to the two are not interchangeable.
 *
 * The bulk buttons are not a convenience. A first sync of a real portfolio proposes
 * around 150 records; a queue that can only be emptied one click at a time is one people
 * abandon, and an abandoned queue means an empty profile, which protects nobody. So the
 * whole list can be decided at once, with the repository named above it. Rejecting in
 * bulk asks twice, because rejection is remembered and there is no undo for it here.
 */

import { useState, useTransition } from 'react';
import {
  approveAllSynced,
  approveSyncedRecord,
  approveSyncedRole,
  rejectAllSynced,
  rejectSyncedRecord,
  rejectSyncedRole,
} from './actions';

const ROW =
  'flex flex-wrap items-center justify-between gap-3 border border-line bg-surface px-3.5 py-2.5';
const APPROVE =
  'btn text-xs';
const REJECT =
  'min-h-11 px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger-tint disabled:opacity-50';

/**
 * One proposed item.
 *
 * No type label on the row, unlike the flagged list next door: these are grouped under
 * a heading that already says what they are, and repeating it made every skill read
 * "Skills / Kubernetes".
 */
export function ProposedRecord({
  id,
  kind,
  text,
  context,
}: {
  id: string;
  /** A role is a separate table, so the two decisions go to different actions. */
  kind: 'record' | 'role';
  text: string;
  /** For a bullet: the job it would be filed under. */
  context?: string;
}) {
  const [pending, startTransition] = useTransition();

  const approve = () =>
    startTransition(() =>
      kind === 'role' ? approveSyncedRole(id) : approveSyncedRecord(id),
    );
  const reject = () =>
    startTransition(() => (kind === 'role' ? rejectSyncedRole(id) : rejectSyncedRecord(id)));

  return (
    <li className={ROW}>
      <span className="min-w-0 text-sm">
        {text}
        {context ? <span className="text-muted"> · {context}</span> : null}
      </span>
      <span className="flex flex-none gap-2">
        <button type="button" disabled={pending} onClick={approve} className={APPROVE}>
          Approve
        </button>
        <button type="button" disabled={pending} onClick={reject} className={REJECT}>
          Reject
        </button>
      </span>
    </li>
  );
}

export function ProposedBulkControls({ count }: { count: number }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => approveAllSynced())}
        className="btn btn-primary text-sm"
      >
        Approve all {count}
      </button>

      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          startTransition(() => rejectAllSynced());
        }}
        className="min-h-11 border border-line px-4 py-2 text-sm font-semibold text-danger hover:bg-danger-tint disabled:opacity-50"
      >
        {confirming ? `Yes — reject all ${count}` : 'Reject all'}
      </button>

      {confirming ? (
        <p role="alert" className="text-sm text-danger">
          This rejects every item above and a later sync will not offer them again.
        </p>
      ) : null}
    </div>
  );
}
