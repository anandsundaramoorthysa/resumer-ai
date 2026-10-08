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
 * From `lg` up this bar is not the navigation at all: components/desktop-sidebar.tsx
 * takes over as a fixed left column with an icon-only state, and the bar is hidden. What
 * follows describes the bar itself, which is still what a phone and a tablet get.
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
import { cookies } from 'next/headers';
import { signOut } from '@/auth';
import { getSession } from '@/lib/server/session';
import { AccountMenu } from '@/components/account-menu';
import { DesktopSidebar } from '@/components/desktop-sidebar';
import { Logo } from '@/components/logo';
import { MobileNav } from '@/components/mobile-nav';
import { NAV_LINKS } from '@/components/nav-links';
import { isSidebarCollapsed, SIDEBAR_COOKIE } from '@/components/sidebar-state';
import { ThemeToggle } from '@/components/theme-toggle';
import { isThemeChoice, THEME_COOKIE, type ThemeChoice } from '@/components/theme-state';

/**
 * Tailwind's max-width scale. Every signed-in page is `6xl`; the rest exist for the
 * header to keep matching a page that has a reason to differ.
 *
 * They used not to. Each page picked its own container and the six of them landed on four
 * different numbers — the dashboard at 1152px, Applications and the resume review at
 * 1024px, Profile at 896px, Import and both Settings screens at 768px. Measured at 1440px
 * that is 80% of the viewport on the dashboard and 53% on Settings, and at 1920px it is
 * 60% against 40%: the same application, navigated between, visibly changing its own
 * margins on every click. The Settings pages were the worst of it — a 768px column of
 * form floating in 1152px of empty page.
 *
 * So the shell is one number now, and the judgement moved inside it. A page does NOT get
 * to fill 1152px by stretching its paragraphs to 1152px — a 180-character line is not
 * "using the space", it is unreadable. The rule the pages follow:
 *
 *   - Tables, stat rows, card grids and editing surfaces take the full container. They
 *     have real columns to give the width to.
 *   - Every paragraph of explanation carries `max-w-prose` (~65ch) regardless of how wide
 *     its container is. Prose keeps its measure; nothing about the container changes it.
 *   - A page that is one column of form plus one block of long-form explanation splits
 *     into `lg:grid-cols-[1.6fr_1fr]` — the dashboard's own proportion — with the
 *     explanation as the right-hand column. The width is then filled by content that was
 *     already on the page rather than by inflating a control.
 *   - The credential pages (/sign-in, /verify-email, /forgot-password, /reset-password)
 *     are deliberately outside all of this. They are one centred `max-w-md` card and do
 *     not render this header's signed-in bar at all.
 */
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
  /**
   * Defaulted to the shell width every page now uses, so a new page that forgets the
   * prop lines up with the rest instead of inheriting the old 1024px outlier.
   */
  width = '6xl',
  session: given,
  minimal = false,
}: {
  /** Wordmark, theme toggle and Sign out only - for accounts that are not approved yet. */
  minimal?: boolean;
  /** The href of the page being rendered, so it can be marked in the nav. */
  current?: string;
  userName?: string | null;
  width?: HeaderWidth;
  /** Pass the page's own session to skip a lookup; defaults to the per-request cached one. */
  session?: Awaited<ReturnType<typeof getSession>>;
}) {
  const container = `mx-auto ${WIDTHS[width]} px-4 sm:px-5`;
  const session = given === undefined ? await getSession() : given;
  const signedIn = Boolean(session?.user?.id);
  const name = userName ?? session?.user?.name ?? null;

  if (!signedIn) {
    const themeValue = (await cookies()).get(THEME_COOKIE)?.value;
    const signedOutTheme: ThemeChoice = isThemeChoice(themeValue) ? themeValue : 'system';
    return (
      <header className="relative border-b border-line bg-paper">
        <div className={`${container} flex h-14 items-center justify-between gap-3`}>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center"
            aria-label="Resumer AI"
          >
            <Logo size={28} />
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle inline choice={signedOutTheme} />
            <Link href="/sign-in" className="btn">
              Sign in
            </Link>
          </div>
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

  // Read here rather than in the sidebar so the server renders the chosen width on the
  // first paint. A client-side read would show the expanded column and then snap narrow.
  const jar = await cookies();
  const collapsed = isSidebarCollapsed(jar.get(SIDEBAR_COOKIE)?.value);
  const themeCookie = jar.get(THEME_COOKIE)?.value;
  const theme: ThemeChoice = isThemeChoice(themeCookie) ? themeCookie : 'system';

  // A signed-in account that is not approved yet (/pending): every nav link would bounce back
  // here, so show only the wordmark, the theme toggle and Sign out.
  if (minimal) {
    return (
      <header className="relative border-b border-line bg-paper">
        <div className={`${container} flex h-14 items-center justify-between gap-3`}>
          <Link href="/pending" className="inline-flex min-h-11 items-center" aria-label="Resumer AI">
            <Logo size={28} />
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle inline choice={theme} />
            <form action={signOutAction}>
              <button type="submit" className="btn">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
    );
  }

  return (
    <>
      <DesktopSidebar
        links={NAV_LINKS}
        current={current}
        userName={name}
        signOut={signOutAction}
        collapsed={collapsed}
        theme={theme}
      />

      {/* `relative` so the phone menu can position against the header rather than the
          page, which keeps it under the bar when the page is scrolled. It is the whole
          navigation below `lg`, and hidden at and above it. */}
      <header className="relative border-b border-line bg-paper lg:hidden">
        <div className={`${container} flex h-14 items-center gap-2 lg:gap-4`}>
          <Link
            href="/"
            className="inline-flex min-h-11 shrink-0 items-center"
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
                      className={`relative inline-flex h-full min-h-11 items-center px-1.5 text-sm transition-colors md:px-2 lg:px-3 ${
                        active ? 'font-semibold text-ink' : 'font-medium text-muted hover:text-ink'
                      }`}
                    >
                      {link.label}
                      {/* Decorative: `aria-current` above is what actually says "you are
                          here". The rule overlaps the header border by a pixel so the two
                          read as one line rather than a bar stacked on another bar. */}
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none absolute inset-x-1.5 -bottom-px h-0.5 lg:inset-x-2.5 ${
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
            <MobileNav
            links={NAV_LINKS}
            current={current}
            userName={name}
            signOut={signOutAction}
            theme={theme}
          />
          </div>
        </div>
      </header>
    </>
  );
}
