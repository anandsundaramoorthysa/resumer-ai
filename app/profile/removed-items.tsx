'use client';

/**
 * The Removed list: what you took out, and the two ways to change your mind.
 *
 * It exists because the block it describes is invisible otherwise. Something removed is
 * now kept out of every sync and every import forever (lib/server/dismissals.ts), and a
 * permanent decision with no screen showing it is a trap — the user would have no way to
 * tell "the portfolio stopped saying it" from "I blocked it two months ago".
 *
 * Closed by default, and at the foot of the page: this is a list of things that are NOT on
 * the profile, so it must never compete with the profile itself. The count is on the
 * summary line so it can be read without opening.
 */

import { useState, useTransition } from 'react';
import { allowAgain, bringBack } from './removed-actions';
import type { Result } from './record-actions';

export interface RemovedItem {
  id: string;
  kind: string;
  type: string;
  label: string;
  source: string;
  removedAt: string;
}

const SOURCE_WORDS: Record<string, string> = {
  'github-sync': 'from your portfolio',
  'ai-import': 'from a resume you uploaded',
  linkedin: 'from your LinkedIn export',
  manual: 'you added by hand',
};

export function RemovedItems({ items }: { items: RemovedItem[] }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<Result | null>(null);
  const [pending, startTransition] = useTransition();

  if (items.length === 0) return null;

  const run = (action: () => Promise<Result>) =>
    startTransition(async () => setNote(await action()));

  return (
    <section className="border-t border-line pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="removed-list"
        className="flex min-h-11 w-full items-baseline justify-between gap-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
      >
        <span>
          <span className="font-display text-lg">Removed</span>
          <span className="ml-2 text-sm text-muted">
            kept out of every sync and import
          </span>
        </span>
        <span className="font-mono text-xs text-muted tabular">
          {items.length} · {open ? 'hide' : 'show'}
        </span>
      </button>

      {open ? (
        <div id="removed-list">
          <p className="mt-2 max-w-prose text-sm text-muted">
            You took these out, so nothing adds them back — not a portfolio sync, not a
            resume import, and they are never asked about again. Bring one back to put it
            on your profile as it was, or allow it again to let a future sync propose its
            own version.
          </p>

          {note ? (
            <p
              role="status"
              className={`mt-3 px-3 py-2 text-sm ${
                note.ok ? 'bg-success-tint text-ink' : 'bg-danger-tint text-ink'
              }`}
            >
              {note.message}
            </p>
          ) : null}

          <ul className="mt-3 divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.label}</span>
                  <span className="block text-xs text-muted">
                    {item.kind === 'role' ? 'Job' : labelType(item.type)} ·{' '}
                    {SOURCE_WORDS[item.source] ?? item.source} · removed {item.removedAt}
                  </span>
                </span>
                <span className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => bringBack(item.id))}
                    className="btn inline-flex text-sm"
                  >
                    Bring it back
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => allowAgain(item.id))}
                    className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-muted hover:bg-paper hover:text-ink disabled:opacity-60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
                  >
                    Allow it again
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** "experience-bullet" is not a word anyone uses about their own resume. */
function labelType(type: string): string {
  if (type === 'experience-bullet') return 'Accomplishment';
  return type.charAt(0).toUpperCase() + type.slice(1);
}
