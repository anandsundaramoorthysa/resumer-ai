/**
 * Which email addresses may open an account.
 *
 * The requirement was "using a random mail, don't allow them to sign in". Three checks,
 * in increasing cost:
 *
 *   1. Shape. A malformed address cannot receive the verification link anyway.
 *   2. A known-disposable domain list. Cheap, exact, and catches the services people
 *      actually use to skip a signup.
 *   3. An MX lookup. A domain with no mail exchanger cannot receive mail at all, which
 *      is a stronger signal than any list — a throwaway service invented this morning
 *      is not on any blocklist, but it still has to publish MX records to work.
 *
 * The list is deliberately short. A long one is a maintenance burden that goes stale and
 * starts rejecting real people, and the MX check plus mandatory verification already
 * carries most of the weight: an address that cannot receive the link never verifies,
 * whatever its domain.
 */

import { resolveMx } from 'node:dns/promises';

/**
 * Domains that exist to be thrown away. Every one of these is a public inbox where
 * anyone can read anyone's mail, so an account behind one is not the user's account.
 */
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com',
  'grr.la', 'spam4.me', '10minutemail.com', '10minutemail.net', 'tempmail.com',
  'temp-mail.org', 'tempmailo.com', 'throwawaymail.com', 'yopmail.com', 'yopmail.fr',
  'trashmail.com', 'trashmail.de', 'dispostable.com', 'fakeinbox.com', 'getnada.com',
  'nada.email', 'maildrop.cc', 'mailnesia.com', 'mintemail.com', 'moakt.com',
  'mohmal.com', 'emailondeck.com', 'tempinbox.com', 'spambog.com', 'mytemp.email',
  'inboxkitten.com', 'harakirimail.com', 'burnermail.io', 'einrot.com', 'discard.email',
  'anonaddy.me', 'byom.de', 'mailcatch.com', 'tmpmail.org', 'luxusmail.org',
  'linshiyouxiang.net', 'emltmp.com', 'vomoto.com', 'crazymailing.com',
]);

/**
 * Domains whose "plus" and dot tricks make one inbox into unlimited addresses. These are
 * not blocked — they are real inboxes belonging to real people — but the address is
 * normalised so one Gmail account cannot hold ten profiles.
 */
const ALIASING_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export interface EmailVerdict {
  ok: boolean;
  /** The address to store and compare on. */
  normalized: string;
  reason?: string;
}

const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Lower-cased, with Gmail's aliasing collapsed.
 *
 * Only Gmail's rules are applied, and only to Gmail: dots being insignificant is a
 * property of that provider, not of email. Stripping dots from every domain would merge
 * two genuinely different people at a provider that treats them as distinct.
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 1) return trimmed;

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (ALIASING_DOMAINS.has(domain)) {
    local = local.split('+')[0].replace(/\./g, '');
    return `${local}@gmail.com`;
  }
  // A plus tag is a common convention everywhere else too, and stripping it stops one
  // person opening a second account with the same inbox.
  return `${local.split('+')[0]}@${domain}`;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export function isDisposableDomain(domain: string): boolean {
  if (DISPOSABLE.has(domain)) return true;
  // Throwaway services hand out subdomains of their own domain freely.
  for (const d of DISPOSABLE) if (domain.endsWith(`.${d}`)) return true;
  return false;
}

/** Shape and blocklist only — no network. Used where a lookup would be too slow. */
export function checkEmailOffline(raw: string): EmailVerdict {
  const normalized = normalizeEmail(raw);

  if (!SHAPE.test(normalized) || normalized.length > 254) {
    return { ok: false, normalized, reason: 'That does not look like an email address.' };
  }
  if (isDisposableDomain(domainOf(normalized))) {
    return {
      ok: false,
      normalized,
      reason:
        'That is a disposable address. Your profile is the only record of your career this holds, so it needs an inbox you will still have next year.',
    };
  }
  return { ok: true, normalized };
}

/**
 * The full check, including whether the domain can receive mail at all.
 *
 * A lookup failure is treated as a pass. DNS is unreliable from inside a serverless
 * function, and refusing a real person because a resolver timed out is a worse outcome
 * than admitting one throwaway address that still has to pass email verification.
 */
export async function checkEmail(raw: string): Promise<EmailVerdict> {
  const offline = checkEmailOffline(raw);
  if (!offline.ok) return offline;

  try {
    const records = await withTimeout(resolveMx(domainOf(offline.normalized)), 3000);
    if (records.length === 0 || records.every((r) => !r.exchange || r.exchange === '.')) {
      return {
        ok: false,
        normalized: offline.normalized,
        reason: 'That domain cannot receive email, so the verification link would never arrive.',
      };
    }
  } catch (err) {
    // NXDOMAIN and NODATA are answers, not failures: the domain genuinely has no mail.
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return {
        ok: false,
        normalized: offline.normalized,
        reason: 'That domain cannot receive email, so the verification link would never arrive.',
      };
    }
  }

  return offline;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), ms)),
  ]);
}
