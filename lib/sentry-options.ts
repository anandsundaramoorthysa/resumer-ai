/**
 * Error reporting to Sentry — the options shared by the browser (instrumentation-client.ts)
 * and the server (instrumentation.ts).
 *
 * Errors only. No tracing, no session replay: the pages hold people's work history, and
 * a replay of the profile page is a copy of it on someone else's servers. Reporting is
 * off wherever NEXT_PUBLIC_SENTRY_DSN is unset, which is every machine but production.
 */

import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs';

/**
 * Removes single-use credentials from anything in an event. Verification and reset links
 * carry `token=`, the GitHub callbacks carry `code=` and `state=`, and a URL turns up in
 * more places than `request.url` — breadcrumbs of the navigation, the transaction, the
 * message of an error thrown while reading it.
 */
export function scrubEvent<T>(event: T): T {
  const text = JSON.stringify(event);
  if (text === undefined) return event;
  let clean = text.replace(/\b(token|code|state|api_key)=[^&"\s#\\]+/g, '$1=[scrubbed]');
  // The SerpApi key itself, wherever it turns up (raw or URL-encoded), not just after `api_key=`.
  // Server-only: the browser has no SERPAPI_API_KEY. Keys under 8 chars are ignored (would shred text).
  const key = typeof process !== 'undefined' ? process.env?.SERPAPI_API_KEY : undefined;
  if (key && key.length >= 8) {
    for (const form of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) {
      clean = clean.split(form).join('[scrubbed]');
    }
  }
  return clean === text ? event : JSON.parse(clean);
}

/** Drops any breadcrumb that mentions serpapi.com (its URLs carry the key), scrubs the rest. */
export function scrubBreadcrumb<T>(crumb: T): T | null {
  const text = JSON.stringify(crumb) ?? '';
  return /serpapi\.com/i.test(text) ? null : scrubEvent(crumb);
}

export const sentryOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  sendDefaultPii: false,
  beforeSend: (event: ErrorEvent) => scrubEvent(event),
  beforeBreadcrumb: (crumb: Breadcrumb) => scrubBreadcrumb(crumb),
};
