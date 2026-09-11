/**
 * Regression tests for the security review's findings.
 *
 * Each one pins a specific hole that was open. These are the checks whose absence is
 * invisible: a rate limiter with the wrong bucket key still returns "allowed", an SSRF
 * guard that only inspects the hostname string still fetches, and a zip reader with a
 * per-entry cap still exhausts memory. Nothing about the working path looks different.
 */

import { LIMITS, isIpAddress, type AuthAction } from '../lib/auth/rate-limit';
import { isPrivateAddress } from '../lib/net/safe-fetch';
import { readZip, inflatedSize, ZipLimitError } from '../lib/import/zip';
import {
  MAX_UPLOAD_BYTES,
  UnsafeUploadError,
  assertDocxIsSafeToExtract,
  extractUploadText,
} from '../lib/import/text';
import { parseRepoRef } from '../lib/sync/github';
import { deflateRawSync } from 'node:zlib';
import { suite, suiteAsync, test, testAsync, assert } from './harness.mjs';

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

/**
 * Every credential action has a ceiling, including the one that guesses nothing.
 *
 * `setInitialPasswordAction` ran unlimited. It leaks nothing and cannot be aimed at
 * another account — the caller must already hold a session for the row it writes — so it
 * reads as harmless, and that is exactly why it stayed unlimited. What it spends is a
 * scrypt hash per call, deliberately about a tenth of a second of a core, bought with one
 * cheap HTTP request. A signed-in user looping it holds serverless instances busy hashing
 * passwords nobody will ever use, and nothing in the app looks wrong while they do.
 *
 * The failure this pins is not "the number changed". It is an action existing in
 * `AuthAction` with no row in `LIMITS`, or a row loosened until it stops bounding
 * anything — both of which leave `rateLimit` returning "allowed" forever.
 */
suite('every action has a ceiling', () => {
  const ACTIONS: AuthAction[] = ['sign-in', 'sign-up', 'reset-request', 'verify', 'set-password', 'ai'];

  test('no action can be added without a limit', () => {
    for (const action of ACTIONS) {
      const limit = LIMITS[action];
      assert(limit !== undefined, `${action} has a row`);
      assert(limit.subject.max > 0 && limit.subject.windowMs > 0, `${action} bounds the subject`);
      assert(limit.ip.max > 0 && limit.ip.windowMs > 0, `${action} bounds the connection`);
    }
    assert.equal(Object.keys(LIMITS).length, ACTIONS.length, 'and this list is the whole table');
  });

  test('setting a first password costs a session at most a second of scrypt an hour', () => {
    // The step happens once per account for its whole life, and the form runs the same
    // `checkPassword` in the browser, so a submit that reaches the server has already
    // passed the strength rules. Ten an hour is roughly ten times what the flow can
    // honestly need; anything in the hundreds would stop being a bound on CPU at all.
    const limit = LIMITS['set-password'];
    assert.equal(limit.subject.windowMs, 60 * 60_000, 'measured over an hour');
    assert(limit.subject.max <= 12, `a session gets few attempts, got ${limit.subject.max}`);
    assert(limit.subject.max >= 3, 'but enough to survive a fumbled form and a reload');
    assert(limit.ip.max >= limit.subject.max, 'one machine may hold more than one session');
  });

  test('the AI burst limit stops a loop and never a person', () => {
    // It is the one ceiling the owner's account still has, so it has to exist; it is also
    // hit during ordinary work (one request per import chunk, one per review batch), so it
    // has to be generous. A loop reaches sixty in seconds; a person does not in ten minutes.
    const limit = LIMITS.ai;
    assert(limit.subject.windowMs <= 15 * 60_000, 'measured over minutes, not hours');
    assert(limit.subject.max >= 40, `a long import still fits, got ${limit.subject.max}`);
    assert(limit.subject.max <= 100, `and a bot is still stopped, got ${limit.subject.max}`);
    assert(limit.ip.max >= limit.subject.max, 'one machine may hold more than one session');
  });

  test('nothing is looser than sign-in, which is the only one guessing pays off against', () => {
    for (const action of ACTIONS) {
      // Not a credential: nothing is guessed by starting a draft, so it is bounded by the
      // burst test above instead.
      if (action === 'sign-in' || action === 'ai') continue;
      const perHour = (LIMITS[action].subject.max * 60 * 60_000) / LIMITS[action].subject.windowMs;
      const signInPerHour =
        (LIMITS['sign-in'].subject.max * 60 * 60_000) / LIMITS['sign-in'].subject.windowMs;
      assert(perHour <= signInPerHour, `${action} allows ${perHour}/h vs sign-in's ${signInPerHour}/h`);
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

/**
 * `declaredSize` defaults to a lie — 1024 bytes whatever the entry really holds —
 * because that is the case the zip tests below exist to pin. A caller that wants an
 * honest archive (the DOCX suite, further down) passes the real size.
 */
function makeZip(files: Array<[string, string, number?]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content, declaredSize] of files) {
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
    // The DECLARED size is a lie by default: small enough to pass the early check,
    // while the stream actually expands to megabytes. This is what makes the per-entry
    // declared-size check useless as a bound.
    central.writeUInt32LE(declaredSize ?? 1024, 24);
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

/* -------------------------------------- DOCX decompression (finding #1) ---- */

/**
 * A DOCX is a ZIP, which is the whole problem: `MAX_UPLOAD_BYTES` bounded the
 * COMPRESSED bytes, and mammoth then handed them to jszip, which inflates with no
 * output ceiling at all. Measured on this machine before the fix, a 0.39MB file built
 * exactly this way came back from `mammoth.extractRawText` as 419,430,402 characters
 * with a peak RSS of 848MB, and a 3.31MB one drove RSS to 3,567MB before dying — from
 * uploads a twentieth and a half of the size cap respectively.
 *
 * These fixtures are the real thing, not a mock: `[Content_Types].xml`, the package
 * relationships, and a `word/document.xml` that is a run of one byte. Mammoth reads the
 * small one, which is what makes the large one a valid upload rather than a broken file.
 */
const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const PACKAGE_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function documentXml(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`
  );
}

/**
 * `declaredSize` left out means "state the truth", which is what Word does — in BYTES,
 * not characters: an em dash is one of the first and three of the second, and jszip
 * checks the inflated byte count against what the archive declared.
 */
function makeDocx(body: string, declaredSize?: number): Buffer {
  const xml = documentXml(body);
  return makeZip([
    ['[Content_Types].xml', CONTENT_TYPES, Buffer.byteLength(CONTENT_TYPES)],
    ['_rels/.rels', PACKAGE_RELS, Buffer.byteLength(PACKAGE_RELS)],
    ['word/document.xml', xml, declaredSize ?? Buffer.byteLength(xml)],
  ]);
}

/** 64MB of one byte, which deflate flattens to a few dozen kilobytes. */
const BOMB_BODY = 'A'.repeat(64 * 1024 * 1024);

suite('DOCX decompression limits', () => {
  test('the bomb is a valid upload by every check that existed before', () => {
    const bomb = makeDocx(BOMB_BODY);
    assert(
      bomb.length < MAX_UPLOAD_BYTES,
      `an 8MB compressed cap does not stop it: this one is ${(bomb.length / 1024).toFixed(0)}KB`,
    );
    assert(
      documentXml(BOMB_BODY).length / bomb.length > 500,
      'and the ratio is what makes the compressed cap meaningless',
    );
  });

  test('a bomb that declares its true size is refused without inflating a byte', () => {
    assert.throws(
      () => assertDocxIsSafeToExtract(makeDocx(BOMB_BODY)),
      (err: unknown) => err instanceof UnsafeUploadError,
      'the central directory said 64MB and the ceiling is 32MB',
    );
  });

  test('a bomb that lies about its size is refused too — the inflate cap is the real bound', () => {
    // 1024 declared, 64MB real. Anything that trusted the central directory would wave
    // this through, which is the mistake `readZip` was already written not to make.
    assert.throws(
      () => assertDocxIsSafeToExtract(makeDocx(BOMB_BODY, 1024)),
      (err: unknown) => err instanceof UnsafeUploadError,
      'a declared size is whatever the attacker typed',
    );
  });

  test('a file that is not a zip at all is refused rather than passed on hopefully', () => {
    // Fail closed: "our reader disagrees with jszip" is exactly the shape a bypass takes.
    assert.throws(
      () => assertDocxIsSafeToExtract(Buffer.from('%PDF-1.7 not a docx')),
      (err: unknown) => err instanceof UnsafeUploadError,
    );
  });

  test('an ordinary resume passes the check', () => {
    assertDocxIsSafeToExtract(makeDocx('Anand Sundaramoorthy — Senior Engineer, Example Corp.'));
  });

  test('the measurement reports the truth about a normal document', () => {
    const size = inflatedSize(makeDocx('a short resume'), {
      maxEntryBytes: 16 * 1024 * 1024,
      maxTotalBytes: 32 * 1024 * 1024,
    });
    assert(size > 500 && size < 5000, `a three-part docx, got ${size} bytes`);
  });

  test('the entry count is bounded, so nothing can hide past the limit', () => {
    // `centralDirectory` stops at maxEntries; if the measurement stopped there quietly,
    // an archive padded past it would carry members jszip inflates and we never saw.
    assert.throws(
      () =>
        inflatedSize(makeDocx('short'), {
          maxEntryBytes: 1024,
          maxTotalBytes: 4096,
          maxEntries: 2,
        }),
      (err: unknown) => err instanceof ZipLimitError,
      'three parts, a ceiling of two',
    );
  });
});

await suiteAsync('DOCX extraction end to end', async () => {
  await testAsync('a real DOCX still extracts its text', async () => {
    const docx = makeDocx('Anand Sundaramoorthy — Senior Engineer, Example Corp.');
    const { text } = await extractUploadText(docx, 'docx');
    assert(
      text.includes('Senior Engineer'),
      `the guard must not break the working path, got ${JSON.stringify(text.slice(0, 60))}`,
    );
  });

  await testAsync('the bomb never reaches mammoth', async () => {
    let message = '';
    try {
      await extractUploadText(makeDocx(BOMB_BODY), 'docx');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert(
      message.includes('expands to far more'),
      `refused by name, got ${JSON.stringify(message)}`,
    );
  });
});

/* ---------------------------------------- repo path segments (finding #3) ---- */

suite('repository reference parsing', () => {
  test('ordinary references still parse', () => {
    for (const input of [
      'anand/portfolio',
      'https://github.com/anand/portfolio',
      'https://github.com/anand/portfolio.git',
      'anand/portfolio/tree/main',
      'Some-Org/my.site_v2',
    ]) {
      const ref = parseRepoRef(input);
      assert(ref !== null, `should parse ${input}`);
    }
  });

  test('a segment that is not a GitHub name is refused', () => {
    // Each of these shapes the request rather than naming a repository: `..` normalises
    // a path segment away under URL parsing and reaches a different endpoint, `?` and
    // `#` turn the rest of the path into a query or a fragment, and a space or a colon
    // is simply not a name GitHub can issue.
    for (const input of [
      'owner/..',
      '../owner',
      'owner/.',
      'owner/repo?per_page=100',
      'owner/repo#fragment',
      'owner/re po',
      'owner/repo:8080',
      'owner/',
      '/repo',
      `owner/${'r'.repeat(200)}`,
    ]) {
      assert.equal(parseRepoRef(input), null, `should refuse ${JSON.stringify(input)}`);
    }
  });
});
