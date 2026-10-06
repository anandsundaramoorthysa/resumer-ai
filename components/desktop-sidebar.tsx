'use client';

/**
 * The desktop navigation, as a left sidebar with an icon-only state.
 *
 * It replaces the top bar from `lg` up, and nothing below it: on a phone and a tablet the
 * bar and its menu (components/mobile-nav.tsx) are still the navigation, because a fixed
 * column costs width that a narrow screen does not have to give.
 *
 * Two things this is careful about, both learned from the header it replaces:
 *
 *   THE STATE SURVIVES        collapsed or expanded is written to a cookie and read on the
 *                             server (components/app-header.tsx), so the first paint is
 *                             already in the state the user chose. Reading it from
 *                             localStorage after hydration would render expanded and then
 *                             snap narrow on every page load.
 *   COLLAPSED IS NOT MUTE     the row carries its label as its accessible name, and the
 *                             word appears beside the icon on hover and on keyboard focus.
 *                             The browser's own `title` tooltip was the first attempt and
 *                             is not good enough: it waits about a second, appears under
 *                             the pointer rather than beside the row, and never shows for
 *                             a keyboard user at all. An icon on its own is a guess.
 *
 * The page makes room for it with one rule in app/globals.css keyed on this component's
 * own class and state, rather than a wrapper every page would have to remember to add.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Logo, LogoMark } from './logo';
import { NavIcon } from './nav-icons';
import { SIDEBAR_COOKIE } from './sidebar-state';
import { ThemeToggle } from './theme-toggle';
import type { ThemeChoice } from './theme-state';
import type { NavLink } from './nav-links';

const ROW =
  'relative flex min-h-11 items-center text-sm transition-colors';

/**
 * The label beside a collapsed row, on hover or keyboard focus.
 *
 * `fixed` rather than `absolute`: the list scrolls, and a chip positioned inside it is
 * clipped at the sidebar's edge — which is exactly where this needs to appear. Fixed keeps
 * its natural vertical position while escaping that box, with no measuring code.
 *
 * `aria-hidden`, because the accessible name is on the row itself — announcing both would
 * read every destination twice. `pointer-events-none` so the chip cannot swallow the click
 * aimed at the icon it is describing.
 */

export function DesktopSidebar({
  links,
  current,
  userName,
  signOut,
  collapsed: initiallyCollapsed,
  theme,
}: {
  links: NavLink[];
  /** The href of the page being rendered, so it can be marked. */
  current?: string;
  userName?: string | null;
  /** The server action, so the sidebar can render its own sign-out form. */
  signOut: () => Promise<void>;
  collapsed: boolean;
  theme: ThemeChoice;
}) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);

  // A year-long cookie rather than localStorage: the server reads it on the next request
  // and renders the right width immediately. `lax` because nothing here is a credential
  // and the value must survive following a link back into the app.
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
  };

  const pad = collapsed ? 'justify-center px-0' : 'gap-3 px-3';

  return (
    <div
      id="app-sidebar"
      // `app-sidebar` and `data-collapsed` are what the stylesheet keys the page's own
      // left padding on. Renaming either without changing app/globals.css puts the
      // navigation on top of the page content.
      className={`app-sidebar fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-line bg-paper transition-[width] duration-150 lg:flex ${
        collapsed ? 'w-[4.5rem]' : 'w-60'
      }`}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className={`flex h-14 shrink-0 items-center border-b border-line ${collapsed ? 'justify-center px-0' : 'gap-2 px-3'}`}>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center"
          aria-label="Resumer AI — dashboard"
        >
          {collapsed ? <LogoMark size={28} /> : <Logo size={28} />}
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label="Main">
        <ul className="flex flex-col gap-0.5">
          {links.map((link) => {
            const active = current === link.href;
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? link.label : undefined}
                                    className={`${ROW} ${pad} ${
                    active
                      ? 'font-semibold text-ink'
                      : 'font-medium text-muted hover:bg-paper hover:text-ink'
                  }`}
                >
                  {/* The 3px vermilion rule is the active marker; aria-current says it to AT. */}
                  <span
                    aria-hidden="true"
                    className={`absolute inset-y-1 left-0 w-[3px] ${active ? 'bg-brand' : 'bg-transparent'}`}
                  />
                  <NavIcon href={link.href} className="shrink-0" />
                  <span className={collapsed ? 'sr-only' : 'truncate'}>{link.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-line px-2 py-2">
        {/* Identity first, then the one destructive action, in that order — the same
            arrangement as the account menu the top bar uses. */}
        <div className={`flex min-h-11 items-center ${pad}`}>
          <span
            aria-hidden="true"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-rule bg-brand-tint text-xs font-semibold tracking-wide text-ink"
          >
            {initials(userName)}
          </span>
          {collapsed ? null : (
            <span className="min-w-0">
              <span className="block font-mono text-xs uppercase tracking-wider text-muted">
                Signed in as
              </span>
              <span className="block truncate text-sm font-semibold text-ink">
                {userName ?? 'Your account'}
              </span>
            </span>
          )}
        </div>

        <ThemeToggle choice={theme} compact={collapsed} className={collapsed ? '' : 'px-1 pb-1 pt-1.5'} />

        <form action={signOut}>
          <button
            type="submit"
            title={collapsed ? 'Sign out' : undefined}
            className={`${ROW} ${pad} w-full font-semibold text-danger hover:bg-danger-tint`}
          >
            <SignOutIcon />
            <span className={collapsed ? 'sr-only' : ''}>Sign out</span>
          </button>
        </form>

        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls="app-sidebar"
          title={collapsed ? 'Expand' : undefined}
          className={`${ROW} ${pad} mt-0.5 w-full font-medium text-muted hover:bg-paper hover:text-ink`}
        >
          <ChevronIcon collapsed={collapsed} />
          <span className={collapsed ? 'sr-only' : ''}>{collapsed ? 'Expand' : 'Collapse'}</span>
        </button>
      </div>
    </div>
  );
}

/** Two letters at most, first and last word — the same rule as the account menu. */
function initials(name: string | null | undefined): string {
  const words = (name ?? '')
    .split(/[\s.]+/)
    .filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return '·';
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : '';
  return (first + last).toUpperCase();
}

function SignOutIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="shrink-0">
      <path d="M12.25 6.25V4.75a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v10.5a1.5 1.5 0 0 0 1.5 1.5h5.5a1.5 1.5 0 0 0 1.5-1.5v-1.5" strokeLinecap="round" />
      <path d="M8.5 10h8.25M14 7.25L16.75 10 14 12.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="shrink-0">
      <path
        d={collapsed ? 'M8 5.5L12.5 10 8 14.5' : 'M12 5.5L7.5 10 12 14.5'}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
