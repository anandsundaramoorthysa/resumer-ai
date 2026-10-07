/** sanitizeEvent over adversarial events: nothing personal survives, nothing throws. */
import { assert, suite, test } from './harness.mjs';
import { redactDeep, sanitizeEvent } from '@/lib/sentry-options';

const nest = (depth: number, leaf: unknown) => {
  let v: unknown = leaf;
  for (let i = 0; i < depth; i++) v = { a: v, list: [v] };
  return v;
};
const EMAIL = 'jane.doe@example.com';
const PHONE = '+91 98765 43210';
const S = (v: unknown) => JSON.stringify(v);
const clean = (ev: object) => S(sanitizeEvent(ev as never));

suite('sentry: deep redaction', () => {
  test('anything deeper than 6 levels becomes [deep], never passes through', () => {
    const out = S(redactDeep(nest(8, { email: EMAIL, phone: PHONE })));
    assert(!out.includes('example.com') && !out.includes('98765'), out);
    assert(out.includes('[deep]'));
  });
  test('shallow strings are still redacted', () => {
    assert(!S(redactDeep({ a: { b: EMAIL } })).includes('example.com'));
  });
});

suite('sentry: whole-event sanitisation', () => {
  const event = {
    event_id: 'abc',
    level: 'error',
    message: `failed for ${EMAIL}`,
    logentry: { message: `call ${PHONE}`, params: [EMAIL, nest(8, EMAIL)] },
    user: { id: 'u1', email: EMAIL, ip_address: '1.2.3.4', username: 'jdoe' },
    tags: { who: EMAIL, deep: nest(8, PHONE) },
    transaction: `/profile?email=${EMAIL}`,
    fingerprint: ['x', EMAIL],
    server_name: `host-${EMAIL}`,
    contexts: { c: nest(8, EMAIL) },
    extra: { e: nest(9, PHONE), plain: EMAIL },
    breadcrumbs: [{ message: EMAIL, data: nest(8, PHONE) }],
    request: {
      url: `https://x.app/p?token=sekret&e=${EMAIL}`,
      query_string: `e=${EMAIL}`,
      data: { resume: EMAIL },
      cookies: { s: 'c' },
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        cookie: 'sid=1',
        authorization: 'Bearer abcdefgh12345',
        'x-forwarded-for': '9.9.9.9',
        'user-agent': 'UA',
        host: 'x.app',
      },
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: `bad ${EMAIL} ${PHONE}`,
          stacktrace: {
            frames: [
              {
                filename: 'a.js?x=' + EMAIL,
                function: 'f',
                vars: { email: EMAIL },
                context_line: `const e = "${EMAIL}"`,
                pre_context: [EMAIL],
                post_context: [PHONE],
              },
            ],
          },
        },
      ],
    },
  };
  const out = clean(event);

  test('no email, phone, query token or IP survives anywhere', () => {
    for (const bad of ['example.com', '98765', 'sekret', '1.2.3.4', '9.9.9.9', 'jdoe', 'sid=1', 'abcdefgh12345', '"UA"']) {
      assert(!out.includes(bad), `${bad} leaked: ${out}`);
    }
  });
  test('frames lose vars and source lines but keep function', () => {
    const e = sanitizeEvent(event as never) as unknown as { exception: { values: { stacktrace: { frames: Record<string, unknown>[] } }[] } };
    const f = e.exception.values[0].stacktrace.frames[0];
    assert(!('vars' in f) && !('context_line' in f) && !('pre_context' in f) && !('post_context' in f));
    assert(f.function === 'f');
  });
  test('headers keep only the allow-list; user keeps the id only', () => {
    const e = sanitizeEvent(event as never) as unknown as { request: { headers: Record<string, string> }; user: Record<string, string> };
    assert.deepEqual(Object.keys(e.request.headers).sort(), ['accept', 'content-type']);
    assert.deepEqual(e.user, { id: 'u1' });
  });
  test('never throws: a hostile getter yields a minimal event, not an exception', () => {
    const hostile = { event_id: 'z', level: 'error', get request() { throw new Error('boom'); } };
    const out2 = sanitizeEvent(hostile as never) as unknown as Record<string, unknown>;
    assert(out2 && out2.event_id === 'z' && !('request' in out2));
  });
  test('a circular event does not throw', () => {
    const c: Record<string, unknown> = { event_id: 'c', extra: {} };
    (c.extra as Record<string, unknown>).self = c;
    assert(sanitizeEvent(c as never));
  });
});
