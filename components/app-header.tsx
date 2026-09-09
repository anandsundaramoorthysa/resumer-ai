/**
 * The one header every signed-in page uses.
 *
 * Before this, six pages each hand-rolled their own `<nav>` with a different subset of the
 * same five destinations, and no page linked to all of them: from Applications you could
 * not reach Import, from Portfolio you could not reach Profile, and from a generated
 * resume you could not reach anything at all — the only way out was the browser's back
 * button. There was also no way to sign out anywhere in the application.
 *
 * So the links live in one list, and every page gets all of them. Adding a destination is
 * a line here rather than an edit to six files that will disagree again within a month.
 *
 * From `sm` up every link is on screen at once. Below that they are behind a menu
 * button — see components/mobile-nav.tsx. Wrapping them was the first attempt and kept
 * everything visible, but six chips became two or three rows and ate about a third of a
 * 320px screen before any content appeared. Hiding navigation is only acceptable if the
 * control behaves the way people expect, which is what that component is careful about.
 *
 * The bar is one row: wordmark, links, account. It used to be two — the wordmark and sign
 * out on top, the links on a second row below — which cost 123px of every page and left a
 * gap between the two that read as a mistake. The links also sat in rounded chips with the
 * active one filled in, so six equally-weighted buttons competed with each other and with
 * the page heading underneath. Now they are plain text on the baseline of the bar and the
 * current page is marked by a 2px rule sitting on the header's own bottom border, which is
 * quieter and says the same thing.
 */

import Link from 'next/link';
import { auth, signOut } from '@/auth';
import { AccountMenu } from '@/components/account-menu';
import { Logo } from '@/components/logo';
import { MobileNav } from '@/components/mobile-nav';
import { NAV_LINKS } from '@/components/nav-links';

/** Tailwind's max-width scale, as the pages use it — each keeps its own content width. */
export type HeaderWidth = '3xl' | '4xl' | '5xl' | '6xl';

const WIDTHS: Record<HeaderWidth, string> = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  '6xl': 'max-w-6xl',
};

/**
 * `current` is matched exactly rather than by prefix.
 *
 * A prefix match would light up "Dashboard" on every page, since its href is "/". The
 * settings pages are siblings, not parents, so nothing here needs prefix behaviour.
 */
function isCurrent(href: string, current?: string): boolean {
  return current === href;
}

/**
 * Whether someone is signed in is read here rather than passed in.
 *
 * The landing page renders this header on both of its branches, so threading a prop meant
 * a signed-out visitor was shown the full application navigation and a **Sign out**
 * button — six links that all bounce straight back to the sign-in page. Asking `auth()`
 * directly means the header cannot disagree with reality, whoever renders it.
 */
export async function AppHeader({
  current,
  userName,
  width = '5xl',
}: {
  /** The href of the page being rendered, so it can be marked in the nav. */
  current?: string;
  userName?: string | null;
  width?: HeaderWidth;
}) {
  const container = `mx-auto ${WIDTHS[width]} px-4 sm:px-5`;
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);
  const name = userName ?? session?.user?.name ?? null;

  if (!signedIn) {
    return (
      <header className="border-b border-line bg-surface">
        <div className={`${container} flex h-14 items-center justify-between gap-3`}>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            aria-label="Resumer AI"
          >
            <Logo size={28} />
          </Link>
          <Link
            href="/sign-in"
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-3.5 text-sm font-semibold hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Sign in
          </Link>
        </div>
      </header>
    );
  }

  /**
   * One server action, used by both layouts.
   *
   * Defined here rather than inline twice so the phone menu and the desktop bar cannot
   * drift into signing out differently. Passing it to a client component is fine — a
   * server action is a reference, not the function body.
   */
  const signOutAction = async () => {
    'use server';
    await signOut({ redirectTo: '/sign-in' });
  };

  return (
    // `relative` so the phone menu can position against the header rather than the page,
    // which keeps it under the bar when the page is scrolled.
    <header className="relative border-b border-line bg-surface">
      <div className={`${container} flex h-14 items-center gap-2 lg:gap-4`}>
        <Link
          href="/"
          className="inline-flex min-h-11 shrink-0 items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          aria-label="Resumer AI — dashboard"
        >
          {/* The name is dropped between `sm` and `md` only. That band is the one width
              where the six links and the wordmark cannot share a row, and navigation is
              the thing this header exists to provide; the mark still carries the identity,
              and on a phone — where the links are behind the menu — the name is back. */}
          <Logo size={28} wordmarkClassName="sm:hidden md:inline" />
        </Link>

        {/*
          * The links, from `sm` up only, on the same row as everything else.
          *
          * The list is full-height (`items-stretch`, `h-full`) so the active rule can sit
          * on the header's bottom border rather than floating above it. The links
          * themselves still declare `min-h-11`: the row is 56px, but the constraint should
          * not depend on that number staying where it is.
          */}
        <nav className="hidden min-w-0 flex-1 self-stretch sm:block" aria-label="Main">
          <ul className="flex h-full items-stretch">
            {NAV_LINKS.map((link) => {
              const active = isCurrent(link.href, current);
              return (
                <li key={link.href} className="flex">
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={`relative inline-flex h-full min-h-11 items-center rounded-md px-2 text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand lg:px-3 ${
                      active ? 'font-semibold text-ink' : 'font-medium text-muted hover:text-ink'
                    }`}
                  >
                    {link.label}
                    {/* Decorative: `aria-current` above is what actually says "you are
                        here". The rule overlaps the header border by a pixel so the two
                        read as one line rather than a bar stacked on another bar. */}
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-x-1.5 -bottom-px h-0.5 rounded-full lg:inset-x-2.5 ${
                        active ? 'bg-brand' : 'bg-transparent'
                      }`}
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex shrink-0 items-center sm:ml-0">
          <AccountMenu name={name} signOut={signOutAction} />
          <MobileNav links={NAV_LINKS} current={current} userName={name} signOut={signOutAction} />
        </div>
      </div>
    </header>
  );
}
