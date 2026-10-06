'use client';

/**
 * The account control at the right end of the header.
 *
 * It replaces a bare uppercase name sitting next to a bordered **Sign out** button. Two
 * problems with that arrangement: the name was decoration that took as much horizontal
 * room as the navigation it competed with, and sign out — the one destructive action in
 * the bar — was the most prominent control on the row. Folding both into an initials
 * button puts identity where every other application puts it and keeps the row to one
 * line, which is the whole point of the redesign.
 *
 * The menu behaviour is deliberately the same as components/mobile-nav.tsx rather than a
 * second interpretation of "dropdown":
 *
 *   - the trigger says what it controls and whether it is open (`aria-expanded`,
 *     `aria-controls`), and carries the account name in its label so a screen reader
 *     announces whose account it is;
 *   - Escape closes it and returns focus to the trigger;
 *   - a click anywhere outside closes it;
 *   - focus moves to the first item on open, so the keyboard path is the visual one.
 *
 * It is hidden below `sm`, where the same name and sign out live inside the phone menu —
 * two controls next to each other on a 320px bar is exactly the crowding this avoids.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Initials from a display name: at most two letters, first and last word.
 *
 * "ANAND S" gives AS, "Anand Sundaramoorthy SA" gives AS rather than ASS — the middle is
 * dropped rather than truncated. A name with no letters at all (an email-shaped display
 * name, say) falls back to a glyph rather than rendering an empty circle.
 */
export function initialsOf(name: string | null | undefined): string | null {
  if (!name) return null;
  const words = name
    .split(/[\s.]+/)
    .map((word) => word.trim())
    .filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return null;
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function AccountMenu({
  name,
  signOut,
}: {
  name?: string | null;
  /** The server action, passed down so the menu can render its own sign-out form. */
  signOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) firstItemRef.current?.focus();
  }, [open]);

  const initials = initialsOf(name);

  return (
    <div className="relative hidden sm:block">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="account-menu-panel"
        aria-label={name ? `Account: ${name}` : 'Account'}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full"
      >
        <span
          aria-hidden="true"
          className={`grid h-8 w-8 place-items-center rounded-full border text-xs font-semibold tracking-wide ${
            open
              ? 'border-brand bg-brand-tint text-ink'
              : 'border-rule bg-brand-tint text-ink hover:border-brand'
          }`}
        >
          {initials ?? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="5.5" r="2.6" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M2.9 13.6a5.1 5.1 0 0 1 10.2 0"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          )}
        </span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          id="account-menu-panel"
          className="absolute right-0 top-full z-40 mt-2 w-56 border border-rule bg-surface p-1 shadow-lg"
        >
          <div className="px-3 py-2">
            <p className="font-mono text-xs uppercase tracking-wider text-muted">
              Signed in as
            </p>
            <p className="mt-0.5 truncate text-sm font-semibold text-ink">{name ?? 'Your account'}</p>
          </div>

          <form action={signOut} className="border-t border-line pt-1">
            <button
              ref={firstItemRef}
              type="submit"
              className="flex min-h-11 w-full items-center px-3 text-sm font-semibold text-danger hover:bg-danger-tint"
            >
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
