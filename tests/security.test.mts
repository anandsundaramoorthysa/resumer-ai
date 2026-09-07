/**
 * Regression tests for the security review's findings.
 *
 * Each one pins a specific hole that was open. These are the checks whose absence is
 * invisible: a rate limiter with the wrong bucket key still returns "allowed", an SSRF
 * guard that only inspects the hostname string still fetches, and a zip reader with a
 * per-entry cap still exhausts memory. Nothing about the working path looks different.
 */

import { isIpAddress } from '../lib/auth/rate-limit';
import { isPrivateAddress } from '../lib/net/safe-fetch';
import { readZip } from '../lib/import/zip';
import { deflateRawSync } from 'node:zlib';
import { suite, test, assert } from './harness.mjs';

/* ------------------------------------------------- IP parsing (finding #2) ---- */

suite('rate-limit bucket keys', () => {
  test('real addresses are accepted', () => {
    for (const ip of ['203.0.113.7', '8.8.8.8', '255.255.255.255', '::1', '2001:db8::1']) {
      assert(isIpAddress(ip), `should accept ${ip}`);
    }
  });

  test('anything that is not an address is refused', () => {
    // An attacker who can put arbitrary text in a bucket key can both evade the limit
    // and inflate the attempts table one long header at a time.
    for (const junk of ['', 'not-an-ip', '999.1.1.1', '1.2.3', 'x'.repeat(200), '<script>']) {
      assert(!isIpAddress(junk), `should refuse ${JSON.stringify(junk.slice(0, 20))}`);
    }
  });
});

/* --------------------------------------------------- SSRF guard (finding #17) ---- */

suite('private address detection', () => {
  test('cloud metadata is refused — the address that matters most', () => {
    assert(isPrivateAddress('169.254.169.254'), 'AWS/GCP/Azure instance metadata');
    assert(isPrivateAddress('::ffff:169.254.169.254'), 'and the IPv4-mapped IPv6 form of it');
  });

  test('loopback and private ranges are refused', () => {
    for (const ip of [
      '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.255',
      '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
      '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    ]) {
      assert(isPrivateAddress(ip), `should refuse ${ip}`);
    }
  });

  test('genuinely public addresses are allowed', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
      assert(!isPrivateAddress(ip), `should allow ${ip}`);
    }
  });

  test('the boundaries of each private range are exact', () => {
    assert(!isPrivateAddress('9.255.255.255'), 'just below 10/8');
    assert(isPrivateAddress('10.0.0.0'), 'the first address of 10/8');
    assert(!isPrivateAddress('11.0.0.0'), 'just above 10/8');
    assert(!isPrivateAddress('172.15.255.255'), 'just below 172.16/12');
    assert(isPrivateAddress('172.16.0.0'), 'the first address of 172.16/12');
    assert(!isPrivateAddress('172.32.0.0'), 'just above 172.16/12');
    assert(!isPrivateAddress('169.253.0.1'), 'not link-local');
    assert(isPrivateAddress('169.254.0.1'), 'link-local');
  });

  test('anything unparseable is treated as unsafe', () => {
    for (const junk of ['', 'localhost', 'example.com', 'not-an-ip', '1.2.3']) {
      assert(isPrivateAddress(junk), `unresolvable must fail closed: ${JSON.stringify(junk)}`);
    }
  });
});

/* --------------------------------------------- zip decompression (finding #3) ---- */

function makeZip(files: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8');
    const body = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20);
    // The DECLARED size is a lie: small enough to pass the early check, while the
    // stream actually expands to megabytes. This is what makes the per-entry
    // declared-size check useless as a bound.
    central.writeUInt32LE(1024, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

suite('zip decompression limits', () => {
  test('the total across all entries is capped, not just each entry', () => {
    // Twenty entries of 1MB each. Every one passes a per-entry cap of 8MB; together they
    // are 20MB, which a per-entry cap alone would happily return in full.
    const oneMeg = 'a'.repeat(1024 * 1024);
    const zip = makeZip(Array.from({ length: 20 }, (_, i) => [`f${i}.csv`, oneMeg] as [string, string]));

    const entries = readZip(zip, { maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 });
    const total = entries.reduce((n, e) => n + e.bytes.length, 0);

    assert(
      total <= 4 * 1024 * 1024,
      `total must respect the aggregate cap, got ${(total / 1024 / 1024).toFixed(1)}MB`,
    );
    assert(entries.length < 20, `and it stops early, kept ${entries.length} of 20`);
  });

  test('a declared size cannot be used to smuggle a large entry through', () => {
    // The central directory above claims 1024 bytes for a megabyte of real content.
    const zip = makeZip([['big.csv', 'b'.repeat(1024 * 1024)]]);
    const entries = readZip(zip, { maxEntryBytes: 4096, maxTotalBytes: 1024 * 1024 });
    for (const e of entries) {
      assert(e.bytes.length <= 4096, `the real bound is the inflate cap, got ${e.bytes.length}`);
    }
  });

  test('a name filter keeps unwanted members from being decompressed at all', () => {
    const zip = makeZip([
      ['Positions.csv', 'a,b\n1,2\n'],
      ['photo.jpg', 'x'.repeat(50_000)],
      ['Skills.csv', 'Name\nSQL\n'],
    ]);
    const entries = readZip(zip, { nameFilter: (n) => /\.csv$/i.test(n) });
    assert(entries.length === 2, `only the CSVs, got ${entries.map((e) => e.name).join(', ')}`);
    assert(!entries.some((e) => e.name.endsWith('.jpg')), 'the image was never inflated');
  });

  test('an ordinary archive still reads completely', () => {
    const entries = readZip(makeZip([['a.csv', 'x'], ['b.csv', 'y']]));
    assert(entries.length === 2, 'the limits do not interfere with a normal export');
  });
});
