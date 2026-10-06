'use client';

/**
 * Light, dark, or whatever the device says.
 *
 * The app followed `prefers-color-scheme` and nothing else, so someone whose laptop is
 * dark at night could not keep this one screen light — a real complaint, and the reason
 * every other application ships this control.
 *
 * How the choice reaches the page, in order:
 *
 *   1. The button writes a `theme` cookie and sets `data-theme` on <html> at once, so the
 *      current page changes under the pointer with no reload.
 *   2. The next page load applies it before first paint, from the inline script in
 *      app/layout.tsx. A React effect would be too late: the page would paint in the
 *      system theme and flip after hydration, which is the flash this avoids.
 *   3. `system` removes the attribute rather than writing one, so the page goes back to
 *      following the device — including when the device changes theme at sunset.
 *
 * The colours themselves are in app/globals.css; this only decides which set applies.
 */

import { useEffect, useState } from 'react';
import {
  nextTheme,
  THEME_COOKIE,
  THEME_ORDER as ORDER,
  themeFromAttribute,
  type ThemeChoice,
} from './theme-state';

const LABELS: Record<ThemeChoice, string> = {
  system: 'Match my device',
  light: 'Light',
  dark: 'Dark',
};

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
}

export function ThemeToggle({
  choice: initial,
  /** Icon-only, for the collapsed sidebar: one button that cycles the three. */
  compact = false,
  /** One 44px icon button for page headers and corners; cycles like `compact`. */
  inline = false,
  className = '',
}: {
  /** Omit where the server cannot read the cookie (global-error): read from <html> after mount. */
  choice?: ThemeChoice;
  compact?: boolean;
  inline?: boolean;
  className?: string;
}) {
  const [choice, setChoice] = useState<ThemeChoice>(initial ?? 'system');

  // The pre-paint script has already set data-theme; adopt it so the icon matches.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading <html> is only possible after mount
    if (initial === undefined) setChoice(themeFromAttribute(document.documentElement.getAttribute('data-theme')));
  }, [initial]);

  const set = (next: ThemeChoice) => {
    setChoice(next);
    apply(next);
  };

  if (compact || inline) {
    const next = nextTheme(choice);
    return (
      <button
        type="button"
        onClick={() => set(next)}
        aria-label={`Theme: ${LABELS[choice]}. Switch to ${LABELS[next]}`}
        title={`Theme: ${LABELS[choice]}`}
        className={
          inline
            ? `inline-flex min-h-11 min-w-11 items-center justify-center border border-rule text-muted transition-colors hover:text-ink ${className}`
            : `flex min-h-11 w-full items-center justify-center text-muted transition-colors hover:bg-surface hover:text-ink ${className}`
        }
      >
        <ThemeIcon choice={choice} />
      </button>
    );
  }

  return (
    <div className={className}>
      <p className="px-1 pb-1 font-mono text-xs uppercase tracking-wider text-muted">Theme</p>
      {/* A group of three pressed-states rather than a radio group: these take effect on
          click with nothing to submit, which is a button's job, not a form control's. */}
      <div role="group" aria-label="Theme" className="flex gap-1">
        {ORDER.map((option) => {
          const active = option === choice;
          return (
            <button
              key={option}
              type="button"
              onClick={() => set(option)}
              aria-pressed={active}
              className={`flex min-h-11 flex-1 items-center justify-center border text-xs font-semibold transition-colors ${
                active
                  ? 'border-ink bg-surface text-ink'
                  : 'border-rule text-muted hover:bg-surface hover:text-ink'
              }`}
            >
              <ThemeIcon choice={option} />
              <span className="sr-only">{LABELS[option]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A screen for "follow the device", a sun for light, a moon for dark. */
function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className="shrink-0"
    >
      {choice === 'system' ? (
        <>
          <rect x="2.75" y="3.75" width="14.5" height="9.5" rx="1.5" />
          <path d="M7.25 16.25h5.5" strokeLinecap="round" />
        </>
      ) : choice === 'light' ? (
        <>
          <circle cx="10" cy="10" r="3.25" />
          <path
            d="M10 2.75v1.5M10 15.75v1.5M17.25 10h-1.5M4.25 10h-1.5M15.13 4.87l-1.06 1.06M5.93 14.07l-1.06 1.06M15.13 15.13l-1.06-1.06M5.93 5.93L4.87 4.87"
            strokeLinecap="round"
          />
        </>
      ) : (
        <path
          d="M16.25 11.4A6.75 6.75 0 0 1 8.6 3.75a6.75 6.75 0 1 0 7.65 7.65Z"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
