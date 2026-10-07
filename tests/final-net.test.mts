/** Client IP selection (TRUST_PROXY) and safe-fetch redirect hygiene. */
import { assert, suite, suiteAsync, test, testAsync } from './harness.mjs';
import { clientIpFrom, isIpAddress } from '../lib/auth/rate-limit';
import { UnsafeUrlError, safeFetchText, type PinnedRequester } from '../lib/net/safe-fetch';

const hdr = (o: Record<string, string>) => (n: string) => o[n] ?? null;

suite('clientIpFrom', () => {
  test('default (netlify): the netlify header wins over every other header', () => {
    const ip = clientIpFrom(hdr({ 'x-nf-client-connection-ip': '203.0.113.7', 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9, 8.8.8.8' }), {});
    assert.equal(ip, '203.0.113.7');
  });
  test('TRUST_PROXY picks exactly one header', () => {
    const h = hdr({ 'x-nf-client-connection-ip': '203.0.113.7', 'cf-connecting-ip': '198.51.100.2', 'x-vercel-forwarded-for': '192.0.2.9' });
    assert.equal(clientIpFrom(h, { TRUST_PROXY: 'cloudflare' }), '198.51.100.2');
    assert.equal(clientIpFrom(h, { TRUST_PROXY: 'vercel' }), '192.0.2.9');
    assert.equal(clientIpFrom(h, { TRUST_PROXY: 'netlify' }), '203.0.113.7');
  });
  test('a forged header of another platform is ignored', () => {
    assert.equal(clientIpFrom(hdr({ 'cf-connecting-ip': '6.6.6.6' }), {}), null);
  });
  test('absent platform header: the LAST x-forwarded-for hop, never the leftmost', () => {
    assert.equal(clientIpFrom(hdr({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.5' }), {}), '203.0.113.5');
  });
  test('junk values are rejected and fall through', () => {
    assert.equal(clientIpFrom(hdr({ 'x-nf-client-connection-ip': 'not-an-ip', 'x-forwarded-for': 'a, 203.0.113.5' }), {}), '203.0.113.5');
    assert.equal(clientIpFrom(hdr({ 'x-forwarded-for': '1.2.3.4, <script>' }), {}), null);
    assert.equal(clientIpFrom(hdr({ 'x-forwarded-for': 'x'.repeat(500) }), {}), null);
  });
  test('TRUST_PROXY=none trusts nothing', () => {
    assert.equal(clientIpFrom(hdr({ 'x-nf-client-connection-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' }), { TRUST_PROXY: 'none' }), null);
  });
  test('isIpAddress uses real parsing: zone ids and odd literals are refused, IPv6 accepted', () => {
    for (const ok of ['203.0.113.7', '::1', '2001:db8::1', '::ffff:1.2.3.4']) assert(isIpAddress(ok), ok);
    for (const bad of ['fe80::1%eth0', '1.2.3', '01.2.3.4x', '1.2.3.4, 5.6.7.8', ' ']) assert(!isIpAddress(bad), bad);
  });
});

const PUBLIC = async () => ['93.184.216.34'];
const reply = (status: number, location: string | null = null) => ({
  status,
  location,
  body: (async function* () {
    yield new TextEncoder().encode('ok');
  })(),
  destroy() {},
});

suiteAsync('safe-fetch redirects', async () => {
  await testAsync('https -> http downgrade is refused', async () => {
    let calls = 0;
    const requester: PinnedRequester = async () => (++calls === 1 ? reply(302, 'http://site.example/next') : reply(200));
    await assert.rejects(() => safeFetchText('https://site.example/', { resolver: PUBLIC, requester }), UnsafeUrlError);
    assert.equal(calls, 1, 'the http hop was never requested');
  });

  await testAsync('http -> https upgrade and same-origin http hops are allowed', async () => {
    let calls = 0;
    const requester: PinnedRequester = async () => (++calls === 1 ? reply(301, 'https://site.example/') : reply(200));
    assert.equal(await safeFetchText('http://site.example/', { resolver: PUBLIC, requester }), 'ok');
  });

  await testAsync('custom headers are dropped on a cross-origin redirect, kept on a same-origin one', async () => {
    const seen: Array<Record<string, string>> = [];
    const hops = ['https://site.example/b', 'https://other.example/c'];
    let i = 0;
    const requester: PinnedRequester = async (_u, _t, headers) => {
      seen.push(headers);
      return i < hops.length ? reply(302, hops[i++]) : reply(200);
    };
    await safeFetchText('https://site.example/a', { resolver: PUBLIC, requester, headers: { Authorization: 'Bearer s3cret' } });
    assert.equal(seen[0].authorization, 'Bearer s3cret');
    assert.equal(seen[1].authorization, 'Bearer s3cret', 'same origin keeps it');
    assert.equal(seen[2].authorization, undefined, 'cross-origin drops it');
    assert.equal(seen[2]['accept-encoding'], 'identity', 'the fixed header stays');
  });
});
