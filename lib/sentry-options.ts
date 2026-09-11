/**
 * Error reporting to Sentry — the options shared by the browser (instrumentation-client.ts)
 * and the server (instrumentation.ts).
 *
 * Errors only. No tracing, no session replay: the pages hold people's work history, and
 * a replay of the profile page is a copy of it on someone else's servers. Reporting is
 * off wherever NEXT_PUBLIC_SENTRY_DSN is unset, which is every machine but production.
 */

import type { ErrorEvent } from '@sentry/nextjs';

/**
 * Removes single-use credentials from anything in an event. Verification and reset links
 * carry `token=`, the GitHub callbacks carry `code=` and `state=`, and a URL turns up in
 * more places than `request.url` — breadcrumbs of the navigation, the transaction, the
 * message of an error thrown while reading it.
 */
export function scrubEvent<T>(event: T): T {
  const text = JSON.stringify(event);
  const clean = text.replace(/\b(token|code|state)=[^&"\s#\\]+/g, '$1=[scrubbed]');
  return clean === text ? event : JSON.parse(clean);
}

export const sentryOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  sendDefaultPii: false,
  beforeSend: (event: ErrorEvent) => scrubEvent(event),
};
