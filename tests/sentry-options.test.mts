/**
 * What leaves for Sentry — lib/sentry-options.ts. A reset link in an error report is a
 * working password reset in someone else's database for an hour.
 */

import { assert, suite, test } from './harness.mjs';
import { scrubEvent, sentryOptions } from '@/lib/sentry-options';

suite('sentry scrubbing', () => {
  test('credentials in URLs are removed wherever they appear', () => {
    const event = {
      request: { url: 'https://x.app/reset-password?token=abc123&x=1', query_string: 'token=abc123' },
      breadcrumbs: [{ data: { from: '/verify-email?token=zzz9', to: '/api/github/callback?code=c0de&state=s7' } }],
    };
    const out = JSON.stringify(scrubEvent(event));
    for (const secret of ['abc123', 'zzz9', 'c0de', 's7']) assert(!out.includes(secret), `${secret} is gone`);
    assert(out.includes('x=1'), 'other parameters stay');
  });

  test('an event with nothing to remove comes back as the same object', () => {
    const event = { message: 'Cannot read properties of undefined', request: { url: 'https://x.app/profile' } };
    assert(scrubEvent(event) === event, 'untouched');
  });

  test('reporting is off without a DSN', () => {
    assert(!process.env.NEXT_PUBLIC_SENTRY_DSN && sentryOptions.enabled === false, 'disabled locally');
  });
});
