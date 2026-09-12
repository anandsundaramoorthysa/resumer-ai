/**
 * The theme choice, in a module both sides can import.
 *
 * Separate from ./theme-toggle.tsx for the reason ./sidebar-state.ts is separate from the
 * sidebar: that file is `'use client'`, and a server component calling a function exported
 * from it fails at request time with "Attempted to call isThemeChoice() from the server" —
 * which typecheck, lint and the build all pass, because it is a runtime boundary rather
 * than a type error. It cost a 500 on every signed-in page once; a plain module cannot.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_COOKIE = 'theme';

/** Anything else — no cookie, or a stale value — means follow the device. */
export function isThemeChoice(value: string | undefined): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}
