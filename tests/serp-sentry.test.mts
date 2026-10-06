/** A SerpApi key must never reach Sentry: not in URLs, messages, breadcrumbs. */

import { assert, suite, test } from './harness.mjs';
import { scrubBreadcrumb, scrubEvent, sentryOptions } from '@/lib/sentry-options';

const KEY = 'fakeSerpKey+/9876543210abcdef';
process.env.SERPAPI_API_KEY = KEY;

suite('serpapi key scrubbing', () => {
  test('api_key= in a URL and the bare / encoded key in a message are removed', () => {
    const event = {
      request: { url: `https://serpapi.com/search.json?engine=google_jobs&api_key=${encodeURIComponent(KEY)}&q=x` },
      message: `fetch failed for key ${KEY} and ${encodeURIComponent(KEY)}`,
      extra: { note: 'api_key=zzz999&other=1' },
    };
    const out = JSON.stringify(scrubEvent(event));
    for (const s of [KEY, encodeURIComponent(KEY), 'zzz999']) assert(!out.includes(s), `${s} is gone`);
    assert(out.includes('other=1'), 'other params stay');
  });

  test('breadcrumbs mentioning serpapi.com are dropped; others are scrubbed', () => {
    assert(scrubBreadcrumb({ category: 'fetch', data: { url: 'https://serpapi.com/search.json?q=x' } }) === null, 'dropped');
    const kept = scrubBreadcrumb({ category: 'navigation', data: { to: '/verify?token=abc123' } });
    assert(kept !== null && !JSON.stringify(kept).includes('abc123'), 'scrubbed');
    assert(typeof sentryOptions.beforeBreadcrumb === 'function', 'wired into the options');
  });
});
