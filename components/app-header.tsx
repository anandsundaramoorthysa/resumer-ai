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
 * On narrow screens the links wrap rather than collapsing behind a menu button. A
 * hamburger would be the conventional choice, but it hides navigation behind a tap and an
 * animation, and the whole complaint this fixes is navigation that could not be reached.
 * Six short labels wrap to two or three rows at 320px, which is a little taller and
 * entirely visible — the right trade when the alternative is hiding things again.
 */

import Link from 'next/link';
import { auth, signOut } from '@/auth';
import { Logo } from '@/components/logo';

export interface NavLink {
  href: string;
  label: string;
}

/**
 * Every destination, in the order someone would use them: the thing you do (dashboard),
 * the thing it is built from (profile), the things that fill the profile (import,
 * portfolio), the record of what you sent (applications), and the settings you rarely
 * touch (answers).
 */
export const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/profile', label: 'Profile' },
  { href: '/import', label: 'Import' },
  { href: '/settings/portfolio', label: 'Portfolio' },
  { href: '/applications', label: 'Applications' },
  { href: '/settings/application', label: 'Answers' },
];

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

  return (
    <header className="border-b border-line bg-surface">
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

          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/sign-in' });
            }}
          >
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm font-semibold text-muted hover:bg-paper hover:text-ink"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      <nav className={`${container} pb-2.5`} aria-label="Main">
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
