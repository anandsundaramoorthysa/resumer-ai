/** lib/log.ts + the Sentry sanitiser: nothing personal or secret leaves in text. */

import { assert, suite, test } from './harness.mjs';
import { formatLine, hashUserId, withRequestId } from '@/lib/log';
import { redactText, sanitizeEvent } from '@/lib/sentry-options';
import type { ErrorEvent } from '@sentry/nextjs';

suite('redactText', () => {
  test('emails, phones, bearer, api_key and long tokens', () => {
    const t = redactText(
      'mail jane.doe@example.com call +1 (415) 555-0132 Bearer abcdef123456789 ?api_key=SECRETVAL tok ' +
        'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8',
    );
    for (const s of ['jane.doe', '555-0132', 'abcdef123456789', 'SECRETVAL', 'a1b2c3d4e5f6a7b8c9d0']) {
      assert(!t.includes(s), `${s} removed: ${t}`);
    }
  });
  test('dates, ordinary words and short numbers survive', () => {
    const t = 'failed at 2026-10-07 12:00 after 3 retries in housekeeping';
    assert(redactText(t) === t, 'unchanged');
  });
  test('truncates', () => assert(redactText('x'.repeat(50), 10).length === 11, 'cut with ellipsis'));
});

suite('log lines', () => {
  test('shape, hashed user, scrubbed secret fields, error serialised', () => {
    const line = JSON.parse(
      formatLine('error', 'boom for a@b.io', { userId: 'user-123', route: '/x', apiKey: 'k', err: new Error('bad Bearer zzzzzzzzzzzz') }),
    );
    assert(line.level === 'error' && line.route === '/x', 'fields');
    assert(line.userId === hashUserId('user-123') && line.userId !== 'user-123', 'hashed');
    assert(line.apiKey === '[redacted]', 'secret key');
    assert(!JSON.stringify(line).includes('a@b.io') && !JSON.stringify(line).includes('zzzzzzzzzzzz'), 'scrubbed');
    assert(line.err.name === 'Error', 'err');
  });
  test('request id from AsyncLocalStorage', () => {
    withRequestId('req-1', () => assert(JSON.parse(formatLine('info', 'm')).requestId === 'req-1', 'carried'));
  });
});

suite('sanitizeEvent', () => {
  test('drops bodies, cookies, auth headers, query strings; truncates messages', () => {
    const ev = {
      message: 'x',
      request: {
        url: 'https://x.app/api/draft?job=secret+text',
        data: { resume: 'my whole resume' },
        cookies: { s: '1' },
        query_string: 'job=secret',
        headers: { Authorization: 'Bearer q', Cookie: 'a=b', 'user-agent': 'ua' },
      },
      exception: { values: [{ type: 'Error', value: 'bad input from a@b.io ' + 'y'.repeat(500) }] },
      extra: { note: 'call 415 555 0132' },
      breadcrumbs: [{ message: 'c@d.io', data: { to: 'e@f.io' } }],
    } as unknown as ErrorEvent;
    const out = sanitizeEvent(ev)!;
    const json = JSON.stringify(out);
    for (const s of ['my whole resume', 'job=secret', 'Bearer q', 'a=b', 'a@b.io', '555 0132', 'c@d.io', 'e@f.io']) {
      assert(!json.includes(s), `${s} gone`);
    }
    assert(!json.includes('"user-agent"'), 'user-agent is dropped (header allow-list)');
    assert(out.exception!.values![0].value!.length <= 301, 'truncated');
    assert(out.request!.url === 'https://x.app/api/draft', 'query stripped');
  });
});
