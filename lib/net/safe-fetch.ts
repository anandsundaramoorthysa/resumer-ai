/**
 * Fetching a URL that came from a user.
 *
 * A bare `fetch` on a user-supplied address is server-side request forgery: the request
 * leaves from inside the hosting environment, with whatever network position that grants.
 * On a cloud host the first thing an attacker reaches for is the instance metadata
 * service — `http://169.254.169.254/latest/meta-data/iam/security-credentials/` — which
 * hands back credentials to anything that can make an HTTP request from the instance.
 * After that: `localhost` ports that were never meant to be public, and anything else
 * inside the VPC.
 *
 * Four things have to be true, and all four are checked here rather than at the call
 * site, because a call site that forgets one is indistinguishable from one that does not:
 *
 *   1. The scheme is http or https. `file://`, `gopher://` and friends are not fetches.
 *   2. Every address the hostname resolves to is publicly routable. Checking the name
 *      is useless — an attacker controls a DNS record and points it at 127.0.0.1.
 *   3. Redirects are followed by hand, so hop two is checked as strictly as hop one.
 *      A permitted host that 302s to the metadata service otherwise walks straight
 *      through a check performed only on the original URL.
 *   4. The body is read with a running byte count, so a response that never ends cannot
 *      exhaust memory before any length is known.
 */

import 'server-only';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {}

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Ranges that must never be reachable from a user-supplied URL.
 *
 * 169.254.0.0/16 is the one that matters most: link-local, and where every major cloud
 * puts its metadata service. The rest are loopback, private and reserved space.
 */
function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;

  const [a, b] = p;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(s)) return true; // unique local
  // IPv4-mapped (::ffff:169.254.169.254) must be judged by the address it maps.
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // not an address we can reason about
}

/**
 * Resolves the hostname and refuses if anything it points at is internal.
 *
 * `all: true` matters: a hostname with two A records, one public and one loopback, would
 * otherwise pass on whichever the resolver happened to return first.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, '');

  if (isIP(bare)) {
    if (isPrivateAddress(bare)) {
      throw new UnsafeUrlError('That address is on an internal network.');
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    throw new UnsafeUrlError('That hostname could not be resolved.');
  }

  if (addresses.length === 0) throw new UnsafeUrlError('That hostname resolves to nothing.');
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsafeUrlError('That hostname points at an internal address.');
    }
  }
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * Fetches a public URL, or throws `UnsafeUrlError`.
 *
 * There is a DNS-rebinding window here that this does not close: the name is resolved
 * for the check and again by `fetch`, and a hostile resolver can answer differently the
 * second time. Closing it properly means connecting to the checked IP with the original
 * Host header, which needs a custom agent. For a feature that reads someone's own
 * portfolio site this is the right stopping point — but it is a known limit, not an
 * oversight, and anything more sensitive should not use this helper.
 */
export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<string | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? 20_000;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('That is not a valid URL.');
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UnsafeUrlError('Only http and https addresses can be read.');
    }
    await assertPublicHost(url.hostname);

    const res = await fetch(url, {
      headers: options.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      // Resolved against the current URL, then checked from the top on the next pass.
      url = new URL(location, url);
      continue;
    }

    if (!res.ok || !res.body) return null;
    return await readCapped(res.body, maxBytes);
  }

  throw new UnsafeUrlError('That address redirected too many times.');
}

/** Reads a stream up to a byte ceiling, then stops — the length is never trusted. */
async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - total;
      if (value.length >= remaining) {
        chunks.push(value.subarray(0, remaining));
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).toString('utf8');
}
