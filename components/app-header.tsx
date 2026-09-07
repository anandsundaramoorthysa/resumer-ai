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
 */

import Link from 'next/link';
import { auth, signOut } from '@/auth';
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
        <div className={`${container} flex items-center justify-between gap-3 py-3`}>
          <Link href="/" className="inline-flex min-h-11 items-center" aria-label="Resumer AI">
            <Logo />
          </Link>
          <Link
            href="/sign-in"
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-3.5 text-sm font-semibold hover:bg-paper"
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
      <div className={`${container} flex items-center justify-between gap-3 py-3`}>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-lg"
          aria-label="Resumer AI — dashboard"
        >
          <Logo />
        </Link>

        <div className="flex items-center gap-2">
          {/* Hidden on the narrowest screens: the name is reassurance, not navigation,
              and it is the first thing worth sacrificing for room. */}
          {name ? (
            <span className="hidden max-w-[16ch] truncate text-sm text-muted sm:inline">
              {name}
            </span>
          ) : null}

          {/* From `sm` up the links are always on screen, so sign out belongs here. On a
              phone it moves inside the menu, where everything else lives. */}
          <form action={signOutAction} className="hidden sm:block">
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm font-semibold text-muted hover:bg-paper hover:text-ink"
            >
              Sign out
            </button>
          </form>

          <MobileNav links={NAV_LINKS} current={current} signOut={signOutAction} />
        </div>
      </div>

      {/*
        * The wrapping row, from `sm` up only.
        *
        * Below that it became two or three rows of chips and took about a third of a
        * 320px screen before any content appeared. Everything visible was the right
        * instinct while there was no menu; a menu that behaves properly is better.
        */}
      <nav className={`${container} hidden pb-2.5 sm:block`} aria-label="Main">
        <ul className="flex flex-wrap gap-1.5">
          {NAV_LINKS.map((link) => {
            const active = isCurrent(link.href, current);
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ${
                    active
                      ? 'bg-brand-tint text-brand-dark'
                      : 'text-muted hover:bg-paper hover:text-ink'
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
