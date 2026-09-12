/**
 * Where the sidebar's expanded/collapsed state lives.
 *
 * A plain module because both sides need it: the server component reads the cookie to
 * render the right width on the first paint (components/app-header.tsx), and the client
 * component writes it on toggle (components/desktop-sidebar.tsx). Importing either into
 * the other would drag auth into the browser bundle, or the browser's state into the
 * server render.
 *
 * Expanded is the default, so a first-time visitor sees labelled navigation rather than a
 * column of unexplained glyphs.
 */

export const SIDEBAR_COOKIE = 'sidebar';

export function isSidebarCollapsed(cookieValue: string | undefined): boolean {
  return cookieValue === 'collapsed';
}
