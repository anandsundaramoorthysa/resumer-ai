/**
 * SSRF guard: every address form that reaches an internal host must be refused, the
 * connection must be pinned to the validated address, and redirects are re-validated.
 */

import {
  UnsafeUrlError,
  isPrivateAddress,
  resolvePublicTarget,
  safeFetchText,
  type PinnedRequester,
} from '../lib/net/safe-fetch';
import { suite, suiteAsync, test, testAsync, assert } from './harness.mjs';

suite('IPv6 and IPv4 bypass forms are refused', () => {
  test('IPv4-mapped, compatible, NAT64, 6to4, site-local, ULA', () => {
    for (const ip of [
      '::ffff:7f00:1', // [::ffff:127.0.0.1] as WHATWG URL prints it
      '::ffff:127.0.0.1',
      '::ffff:a9fe:a9fe', // metadata
      '::ffff:169.254.169.254',
      '::ffff:0a00:0001',
      '::7f00:1',
      '::127.0.0.1',
      '::',
      '::1',
      '0:0:0:0:0:0:0:1',
      '64:ff9b::7f00:1',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::8.8.8.8',
      '2002:7f00:1::',
      '2002:a9fe:a9fe::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
      'fec0::1',
      'feff::1',
      'fe80::1%eth0',
      'fc00::1',
      'fdff::1',
      'ff02::1',
    ]) {
      assert(isPrivateAddress(ip), `should refuse ${ip}`);
    }
  });

  test('new URL normalises odd IPv4 spellings, and the result is refused', () => {
    for (const u of [
      'http://2130706433/', // decimal 127.0.0.1
      'http://0177.0.0.1/', // octal
      'http://0x7f.1/', // hex
      'http://0xa9fea9fe/', // hex metadata
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::7f00:1]/',
    ]) {
      const host = new URL(u).hostname;
      assert(isPrivateAddress(host), `${u} -> ${host} should be refused`);
    }
  });

  test('un-normalised legacy IPv4 spellings fail closed', () => {
    for (const s of ['2130706433', '0177.0.0.1', '0x7f.1', '127.1']) {
      assert(isPrivateAddress(s), `should refuse ${s}`);
    }
  });

  test('private/special IPv4 ranges', () => {
    for (const ip of [
      '0.0.0.1', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '192.0.0.1', '192.168.0.1', '198.18.0.1', '198.19.255.255', '224.0.0.1',
      '255.255.255.255',
    ]) {
      assert(isPrivateAddress(ip), `should refuse ${ip}`);
    }
  });

  test('public addresses pass, including public mapped forms', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808']) {
      assert(!isPrivateAddress(ip), `should allow ${ip}`);
    }
  });

  test('the Lambda runtime address is refused', () => {
    const prev = process.env.AWS_LAMBDA_RUNTIME_API;
    process.env.AWS_LAMBDA_RUNTIME_API = '8.8.4.4:9001';
    try {
      assert(isPrivateAddress('8.8.4.4'), 'runtime host is blocked even if it looks public');
    } finally {
      if (prev === undefined) delete process.env.AWS_LAMBDA_RUNTIME_API;
      else process.env.AWS_LAMBDA_RUNTIME_API = prev;
    }
  });
});

suiteAsync('resolution and pinning', async () => {
  await testAsync('one private record among public ones refuses the host', async () => {
    let threw = false;
    try {
      await resolvePublicTarget('evil.example', async () => ['8.8.8.8', '::ffff:7f00:1']);
    } catch (e) {
      threw = e instanceof UnsafeUrlError;
    }
    assert(threw, 'must refuse');
  });

  await testAsync('the connection is pinned to the validated address, resolved once', async () => {
    let lookups = 0;
    const seen: string[] = [];
    const requester: PinnedRequester = async (url, target) => {
      seen.push(`${url.hostname}->${target.address}`);
      return {
        status: 200,
        location: null,
        body: (async function* () { yield new TextEncoder().encode('hello'); })(),
        destroy() {},
      };
    };
    const out = await safeFetchText('https://site.example/x', {
      resolver: async () => { lookups++; return lookups === 1 ? ['93.184.216.34'] : ['127.0.0.1']; },
      requester,
    });
    assert(out === 'hello', 'body returned');
    assert(lookups === 1, 'DNS consulted exactly once for the hop');
    assert(seen[0] === 'site.example->93.184.216.34', `pinned: ${seen[0]}`);
  });

  await testAsync('every redirect hop is re-validated', async () => {
    const requester: PinnedRequester = async () => ({
      status: 302,
      location: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
      body: null,
      destroy() {},
    });
    let threw = false;
    try {
      await safeFetchText('https://site.example/', { resolver: async () => ['93.184.216.34'], requester });
    } catch (e) {
      threw = e instanceof UnsafeUrlError;
    }
    assert(threw, 'redirect to metadata must be refused');
  });

  await testAsync('redirect loops are capped', async () => {
    let calls = 0;
    const requester: PinnedRequester = async () => {
      calls++;
      return { status: 301, location: '/again', body: null, destroy() {} };
    };
    let threw = false;
    try {
      await safeFetchText('https://site.example/', { resolver: async () => ['93.184.216.34'], requester });
    } catch (e) {
      threw = e instanceof UnsafeUrlError;
    }
    assert(threw && calls === 4, `capped after ${calls} requests`);
  });

  await testAsync('non-http schemes are refused', async () => {
    let threw = false;
    try { await safeFetchText('file:///etc/passwd'); } catch (e) { threw = e instanceof UnsafeUrlError; }
    assert(threw, 'file: refused');
  });
});
