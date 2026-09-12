'use client';

/**
 * The phone navigation menu.
 *
 * The links used to wrap onto two or three rows below `sm`, which kept everything
 * visible but cost most of the screen before any content appeared — on a 320px phone the
 * header ran to about a third of the viewport. A menu gives that back.
 *
 * The reason to be careful here is that the complaint this whole header exists to fix was
 * navigation that could not be reached. Hiding it behind a button is only acceptable if
 * the button behaves the way people expect a menu to behave, so:
 *
 *   - the trigger says what it controls and whether it is open (`aria-expanded`,
 *     `aria-controls`), which is what a screen reader announces;
 *   - Escape closes it and returns focus to the trigger, so a keyboard user is never
 *     stranded inside;
 *   - a click anywhere outside closes it, because a menu that only closes via its own
 *     button feels broken;
 *   - focus moves to the first item on open, so the keyboard path is the visual one;
 *   - navigating closes it, or the menu would still be covering the page you asked for;
 *   - it renders as a real `<nav>` with a list, not a div of links.
 *
 * Sign out sits inside the menu on phones, under the name it belongs to; from `sm` up the
 * same pair lives in the account menu — see components/account-menu.tsx. It is the one
 * action people look for when they cannot find anything else, so it is never more than two
 * taps away wherever it is.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';
import type { ThemeChoice } from './theme-state';
import type { NavLink } from './nav-links';

export function MobileNav({
  links,
  current,
  userName,
  signOut,
  theme,
}: {
  links: NavLink[];
  current?: string;
  /** Shown at the foot of the panel. From `sm` up the same name is in the account menu. */
  userName?: string | null;
  /** The server action, passed down so the menu can render its own sign-out form. */
  signOut: () => Promise<void>;
  /** The stored theme choice — the phone gets the same control the sidebar has. */
  theme: ThemeChoice;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLAnchorElement>(null);

  // Escape closes and hands focus back, which is the behaviour that makes a menu safe to
  // open with a keyboard: there is always a way out that does not require the mouse.
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

  // Focus the first destination on open. Without this, tabbing after opening continues
  // from the trigger and walks past the menu entirely.
  useEffect(() => {
    if (open) firstItemRef.current?.focus();
  }, [open]);

  return (
    <div className="sm:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? 'Close menu' : 'Open menu'}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line text-muted hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {/* Drawn rather than lettered, so it reads as a control at any text size. The
            bars become a cross when open, which is the state people check visually. */}
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="none">
          {open ? (
            <>
              <path d="M5 5l10 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </>
          ) : (
            <>
              <path d="M3 6h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M3 10h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M3 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </>
          )}
        </svg>
      </button>

      {open ? (
        <div
          ref={panelRef}
          id="mobile-nav-panel"
          // `top-full` rather than the panel's static position: the containing block is
          // the header itself, so this pins the panel to the bar's bottom edge whatever
          // height the row happens to be.
          className="absolute inset-x-0 top-full z-40 border-b border-line bg-surface px-4 pb-3 pt-2 shadow-lg"
        >
          <nav aria-label="Main">
            <ul className="flex flex-col">
              {links.map((link, index) => {
                const active = current === link.href;
                return (
                  <li key={link.href}>
                    <Link
                      ref={index === 0 ? firstItemRef : undefined}
                      href={link.href}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                      className={`flex min-h-11 items-center rounded-lg px-3 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand ${
                        active
                          ? 'bg-brand-tint font-semibold text-brand-dark'
                          : 'font-medium text-ink hover:bg-paper'
                      }`}
                    >
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="mt-1 border-t border-line pt-2">
            <ThemeToggle choice={theme} className="px-3 pb-1" />
          </div>

          <div className="mt-1 border-t border-line pt-1">
            {userName ? (
              <p className="truncate px-3 pb-1 pt-1.5 text-xs text-muted">
                Signed in as <span className="font-semibold text-ink">{userName}</span>
              </p>
            ) : null}
            <form action={signOut}>
              <button
                type="submit"
                className="flex min-h-11 w-full items-center rounded-lg px-3 text-sm font-semibold text-danger hover:bg-danger-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
