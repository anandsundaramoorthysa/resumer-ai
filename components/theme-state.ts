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

export const THEME_ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

/** What one press of a cycling button switches to: system, then light, then dark, then round. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return THEME_ORDER[(THEME_ORDER.indexOf(choice) + 1) % THEME_ORDER.length];
}

/**
 * The choice implied by <html data-theme>, which the pre-paint script sets. For client-only
 * boundaries that cannot read the cookie on the server. No attribute means `system`.
 */
export function themeFromAttribute(attr: string | null | undefined): ThemeChoice {
  return attr === 'light' || attr === 'dark' ? attr : 'system';
}
