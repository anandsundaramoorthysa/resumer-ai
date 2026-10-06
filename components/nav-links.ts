/**
 * The navigation destinations, in one list.
 *
 * Separated from `app-header.tsx` because that file is a server component that imports
 * `auth`, and the mobile menu is a client component that needs the same list. Importing
 * the header into the client bundle to reach it would drag the auth machinery along with
 * it; a plain data module crosses the boundary for free.
 */

export interface NavLink {
  href: string;
  label: string;
}

/**
 * In the order someone would use them: the thing you do (dashboard), the thing it is
 * built from (profile), the things that fill it (import, portfolio), the record of what
 * you sent (applications), what happened under the hood (activity), and the settings you
 * rarely touch (answers).
 */
export const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/radar', label: 'Job Radar' },
  { href: '/profile', label: 'Profile' },
  { href: '/import', label: 'Import' },
  { href: '/settings/portfolio', label: 'Portfolio' },
  { href: '/applications', label: 'Applications' },
  { href: '/activity', label: 'Activity' },
  { href: '/settings/application', label: 'Answers' },
  { href: '/settings/account', label: 'Account' },
];
