/**
 * Fetching a URL that came from a user.
 *
 * A bare `fetch` on a user-supplied address is server-side request forgery: the request
 * leaves from inside the hosting environment, with whatever network position that grants.
 * On a cloud host the first thing an attacker reaches for is the instance metadata
 * service — `http://169.254.169.254/latest/meta-data/iam/security-credentials/` — which
 * hands back credentials to anything that can make an HTTP request from the instance.
 *
 * Everything is checked here rather than at the call site:
 *
 *   1. The scheme is http or https.
 *   2. The hostname is resolved ONCE, every returned address must be publicly routable,
 *      and the connection is then PINNED to the validated address (the socket connects to
 *      the IP; `Host` and TLS SNI keep the original name). Resolving for the check and
 *      again inside `fetch` is a DNS-rebinding window — a hostile resolver answers public
 *      the first time and 169.254.169.254 the second. There is no second lookup now.
 *   3. Redirects are followed by hand, capped, and each hop goes through 1 and 2 again;
 *      https->http downgrades are refused and custom headers are dropped on a cross-origin hop.
 *   4. The body is read with a running byte count.
 *
 * Address judgement works on parsed bytes, not strings: IPv4-mapped (`::ffff:7f00:1` —
 * which is how WHATWG URL prints `[::ffff:127.0.0.1]`), IPv4-compatible (`::7f00:1`),
 * NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), Teredo and site-local (`fec0::/10`) all
 * either embed an IPv4 address that is judged by the IPv4 rules, or are refused outright.
 * Decimal/octal/hex IPv4 spellings (`2130706433`, `0177.0.0.1`, `0x7f.1`) are normalised
 * by `new URL` before they get here, and any string that is still not a canonical IP
 * literal fails closed.
 */

import 'server-only';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {}

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Parsed IPv4, or null. Expects canonical dotted decimal (what `isIP` accepts). */
function parseIpv4(ip: string): number[] | null {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return p;
}

function isPrivateIpv4Bytes(p: number[]): boolean {
  const [a, b] = p;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments (192.0.0.0/24, TEST-NET-1)
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const p = parseIpv4(ip);
  return p === null ? true : isPrivateIpv4Bytes(p);
}

/** Expands an IPv6 literal into eight 16-bit groups, or null if it does not parse. */
function parseIpv6(raw: string): number[] | null {
  let s = raw.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);

  // A dotted-quad tail (::ffff:1.2.3.4) is two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = parseIpv4(dotted[2]);
    if (!v4) return null;
    s = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;

  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

function isPrivateIpv6(ip: string): boolean {
  const g = parseIpv6(ip);
  if (!g) return true; // fail closed

  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);

  // ::/96 — unspecified, loopback (::1) and the deprecated IPv4-compatible form (::7f00:1).
  if (firstFiveZero && g[5] === 0) return true;
  // ::ffff:0:0/96 — IPv4-mapped. Judged by the address it carries.
  if (firstFiveZero && g[5] === 0xffff) return isPrivateIpv4Bytes(v4FromGroups(g[6], g[7]));
  // ::ffff:0:a.b.c.d (SIIT, RFC 2765) — same idea.
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) {
    return isPrivateIpv4Bytes(v4FromGroups(g[6], g[7]));
  }
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64 reaches whatever v4 address is embedded.
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;
  // 2002::/16 — 6to4, embeds a v4 address in g[1..2].
  if (g[0] === 0x2002) return true;
  // 2001::/32 — Teredo, also embeds v4.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  // 100::/64 — discard-only.
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** The host AWS Lambda serves its runtime API on (normally 127.0.0.1:9001). */
function lambdaRuntimeHost(): string | null {
  const api = process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) return null;
  return api.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const runtime = lambdaRuntimeHost();
  if (runtime && bare.toLowerCase() === runtime) return true;
  if (version === 4) return isPrivateIpv4(bare);
  if (version === 6) return isPrivateIpv6(bare);
  return true; // not an address we can reason about
}

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

/**
 * Resolves the hostname ONCE and returns the single address the connection will be
 * pinned to — or refuses if ANY address it resolved to is internal (`all` matters: two A
 * records, one public and one loopback, would otherwise pass on whichever came first).
 */
export async function resolvePublicTarget(
  hostname: string,
  resolver: Resolver = defaultResolver,
): Promise<ResolvedTarget> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  const runtime = lambdaRuntimeHost();
  if (runtime && bare.toLowerCase() === runtime) {
    throw new UnsafeUrlError('That address is on an internal network.');
  }

  const literal = isIP(bare);
  if (literal) {
    if (isPrivateAddress(bare)) throw new UnsafeUrlError('That address is on an internal network.');
    return { address: bare, family: literal as 4 | 6 };
  }

  let addresses: string[];
  try {
    addresses = await resolver(bare);
  } catch {
    throw new UnsafeUrlError('That hostname could not be resolved.');
  }

  if (addresses.length === 0) throw new UnsafeUrlError('That hostname resolves to nothing.');
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsafeUrlError('That hostname points at an internal address.');
    }
  }
  const address = addresses[0];
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}

export interface PinnedResponse {
  status: number;
  location: string | null;
  /** Null when there is nothing to read. */
  body: AsyncIterable<Uint8Array> | null;
  destroy(): void;
}

/** Performs one request to an already-validated address. Injectable for tests. */
export type PinnedRequester = (
  url: URL,
  target: ResolvedTarget,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<PinnedResponse>;

/**
 * Connects to `target.address` directly — no DNS happens inside this call. `Host` keeps
 * the original name, and TLS uses it for SNI and certificate verification.
 */
const nodeRequester: PinnedRequester = (url, target, headers, signal) =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const req = (secure ? https : http).request(
      {
        host: target.address,
        family: target.family,
        port: url.port ? Number(url.port) : secure ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { ...headers, host: url.host },
        servername: secure && !isIP(hostname) ? hostname : undefined,
        agent: false,
        signal,
      },
      (res) => {
        const loc = res.headers.location;
        resolve({
          status: res.statusCode ?? 0,
          location: typeof loc === 'string' ? loc : null,
          body: res,
          destroy: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Test seams: a deterministic resolver and requester. Not for production callers. */
  resolver?: Resolver;
  requester?: PinnedRequester;
}

/** Fetches a public URL, or throws `UnsafeUrlError`. */
export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<string | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const requester = options.requester ?? nodeRequester;
  const signal = AbortSignal.timeout(timeoutMs);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('That is not a valid URL.');
  }

  let customHeaders = lowerKeys(options.headers);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UnsafeUrlError('Only http and https addresses can be read.');
    }
    const target = await resolvePublicTarget(url.hostname, options.resolver);

    const res = await requester(
      url,
      target,
      { 'accept-encoding': 'identity', ...customHeaders },
      signal,
    );

    if (res.status >= 300 && res.status < 400) {
      res.destroy();
      if (!res.location) return null;
      // Resolved against the current URL, then checked from the top on the next pass.
      let next: URL;
      try {
        next = new URL(res.location, url);
      } catch {
        throw new UnsafeUrlError('That address redirected somewhere invalid.');
      }
      // Never step down from TLS, and never carry caller-supplied headers (which may hold a
      // credential) to a different origin.
      if (url.protocol === 'https:' && next.protocol === 'http:') {
        throw new UnsafeUrlError('That address redirected from https to http, which is refused.');
      }
      if (next.origin !== url.origin) customHeaders = {};
      url = next;
      continue;
    }

    if (res.status < 200 || res.status >= 300 || !res.body) {
      res.destroy();
      return null;
    }
    try {
      return await readCapped(res.body, maxBytes);
    } finally {
      res.destroy();
    }
  }

  throw new UnsafeUrlError('That address redirected too many times.');
}

function lowerKeys(h?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/** Reads a stream up to a byte ceiling, then stops — the length is never trusted. */
async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const value of body) {
    const remaining = maxBytes - total;
    if (value.length >= remaining) {
      chunks.push(value.subarray(0, remaining));
      break;
    }
    chunks.push(value);
    total += value.length;
  }

  return Buffer.concat(chunks).toString('utf8');
}
