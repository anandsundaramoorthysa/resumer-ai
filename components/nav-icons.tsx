/**
 * One icon per navigation destination.
 *
 * Drawn inline rather than pulled from an icon package: eight glyphs do not justify a
 * dependency, and geometry that ships with the markup cannot fail to load and leave a
 * collapsed sidebar showing eight empty squares — which is the whole navigation, gone.
 *
 * Each is a 20x20 stroke drawing on the same grid and weight as the menu button in
 * components/mobile-nav.tsx, so they read as one family. They are decorative: every link
 * carries its own text label (visible when expanded, `sr-only` when collapsed), so these
 * are `aria-hidden` and never the accessible name.
 */

const PATHS: Record<string, React.ReactNode> = {
  // Dashboard — four panes.
  '/': (
    <>
      <rect x="2.75" y="2.75" width="6" height="6" rx="0" />
      <rect x="11.25" y="2.75" width="6" height="6" rx="0" />
      <rect x="2.75" y="11.25" width="6" height="6" rx="0" />
      <rect x="11.25" y="11.25" width="6" height="6" rx="0" />
    </>
  ),
  // Job Radar — a radar sweep.
  '/radar': (
    <>
      <circle cx="10" cy="10" r="7.25" />
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 10l5-5" strokeLinecap="round" />
    </>
  ),
  // Profile — a person.
  '/profile': (
    <>
      <circle cx="10" cy="6.5" r="3.25" />
      <path d="M3.75 16.75a6.25 6.25 0 0 1 12.5 0" strokeLinecap="round" />
    </>
  ),
  // Import — into the app, so the arrow points down into a tray.
  '/import': (
    <>
      <path d="M10 2.75v8.5" strokeLinecap="round" />
      <path d="M6.5 8l3.5 3.5L13.5 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.75 13.25v2.5a1.5 1.5 0 0 0 1.5 1.5h9.5a1.5 1.5 0 0 0 1.5-1.5v-2.5" strokeLinecap="round" />
    </>
  ),
  // Portfolio — a repository branch.
  '/settings/portfolio': (
    <>
      <circle cx="6" cy="4.75" r="1.9" />
      <circle cx="6" cy="15.25" r="1.9" />
      <circle cx="14" cy="7.75" r="1.9" />
      <path d="M6 6.65v6.7" strokeLinecap="round" />
      <path d="M14 9.65c0 2.4-1.9 3.6-4.4 3.9" strokeLinecap="round" />
    </>
  ),
  // Applications — a clipboard of what was sent.
  '/applications': (
    <>
      <path d="M7.25 3.75h-1.5a1.5 1.5 0 0 0-1.5 1.5v10.5a1.5 1.5 0 0 0 1.5 1.5h8.5a1.5 1.5 0 0 0 1.5-1.5V5.25a1.5 1.5 0 0 0-1.5-1.5h-1.5" />
      <rect x="7.25" y="2.25" width="5.5" height="3" rx="1" />
      <path d="M7.5 9.5h5M7.5 12.5h3.5" strokeLinecap="round" />
    </>
  ),
  // Activity — a pulse line.
  '/activity': <path d="M2.75 10h3l2-5 4 10 2-5h3.5" strokeLinecap="round" strokeLinejoin="round" />,
  // Answers — a question in a speech bubble.
  '/settings/application': (
    <>
      <path d="M16.25 11.5a2.25 2.25 0 0 1-2.25 2.25H8l-3.5 2.75v-2.75a2.25 2.25 0 0 1-1.75-2.25v-5A2.25 2.25 0 0 1 5 4.25h9a2.25 2.25 0 0 1 2.25 2.25v5Z" strokeLinejoin="round" />
      <path d="M8.4 7.6a1.6 1.6 0 1 1 1.9 1.85v1.05" strokeLinecap="round" />
    </>
  ),
  // Account — the settings gear.
  '/settings/account': (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path
        d="M10 2.75l1.1 1.9 2.2-.3.5 2.15 1.95 1.05-1 1.95 1 1.95-1.95 1.05-.5 2.15-2.2-.3L10 17.25l-1.1-1.9-2.2.3-.5-2.15L4.25 12.45l1-1.95-1-1.95L6.2 7.5l.5-2.15 2.2.3L10 2.75Z"
        strokeLinejoin="round"
      />
    </>
  ),
};

/** The glyph for a destination, or a neutral dot for one this file has not met. */
export function NavIcon({ href, className }: { href: string; className?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className={className}
    >
      {PATHS[href] ?? <circle cx="10" cy="10" r="3.25" />}
    </svg>
  );
}
