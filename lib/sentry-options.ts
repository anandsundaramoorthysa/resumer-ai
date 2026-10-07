/**
 * Error reporting to Sentry — the options shared by the browser (instrumentation-client.ts)
 * and the server (instrumentation.ts).
 *
 * Errors only. No tracing, no session replay: the pages hold people's work history, and
 * a replay of the profile page is a copy of it on someone else's servers. Reporting is
 * off wherever NEXT_PUBLIC_SENTRY_DSN is unset, which is every machine but production.
 */

import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs';

/**
 * Removes single-use credentials from anything in an event. Verification and reset links
 * carry `token=`, the GitHub callbacks carry `code=` and `state=`, and a URL turns up in
 * more places than `request.url` — breadcrumbs of the navigation, the transaction, the
 * message of an error thrown while reading it.
 */
export function scrubEvent<T>(event: T): T {
  const text = JSON.stringify(event);
  if (text === undefined) return event;
  let clean = text.replace(/\b(token|code|state|api_key)=[^&"\s#\\]+/g, '$1=[scrubbed]');
  // The SerpApi key itself, wherever it turns up (raw or URL-encoded), not just after `api_key=`.
  // Server-only: the browser has no SERPAPI_API_KEY. Keys under 8 chars are ignored (would shred text).
  const key = typeof process !== 'undefined' ? process.env?.SERPAPI_API_KEY : undefined;
  if (key && key.length >= 8) {
    for (const form of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) {
      clean = clean.split(form).join('[scrubbed]');
    }
  }
  return clean === text ? event : JSON.parse(clean);
}

/** Drops any breadcrumb that mentions serpapi.com (its URLs carry the key), scrubs the rest. */
export function scrubBreadcrumb<T>(crumb: T): T | null {
  const text = JSON.stringify(crumb) ?? '';
  return /serpapi\.com/i.test(text) ? null : scrubEvent(crumb);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Redacts what must not leave in free text: emails, phone numbers, bearer credentials and
 * long opaque tokens. An error message can quote resume or job text, so the same function
 * also truncates (`max`, default unlimited). Pure; shared with lib/log.ts.
 */
export function redactText(text: string, max = Infinity): string {
  const out = text
    .replace(/\b(api[_-]?key|token|secret|password|access_token)=[^&\s"'#]+/gi, '$1=[scrubbed]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(EMAIL, '[email]')
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '').length;
      return digits >= 9 && digits <= 15 && !ISO_DATE.test(m) ? '[phone]' : m;
    })
    .replace(LONG_TOKEN, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '[token]' : m));
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Recursively redacts every string in a value. Anything nested deeper than 6 levels is replaced, never passed through. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[deep]' as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, depth + 1);
  return out as T;
}

const EXCEPTION_MESSAGE_MAX = 300;
/** The only request headers that leave. Everything else (cookie, authorization, x-forwarded-for, user-agent, host...) is dropped. */
const SAFE_HEADERS = new Set(['content-type', 'accept', 'accept-language', 'content-length']);

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const text = (v: unknown, max = EXCEPTION_MESSAGE_MAX) => (typeof v === 'string' ? redactText(v, max) : v);
const noQuery = (v: unknown) => (typeof v === 'string' ? redactText(v.split(/[?#]/)[0]) : v);

/** Source lines and local variables can quote anything the code held; frames keep only where they are. */
function cleanStacktrace(st: Loose | undefined): Loose | undefined {
  if (!st || typeof st !== 'object') return st;
  if (!Array.isArray(st.frames)) return redactDeep(st);
  return {
    ...st,
    frames: st.frames.map((f: Loose) => {
      const { vars: _v, context_line: _c, pre_context: _p, post_context: _q, ...rest } = f ?? {}; // eslint-disable-line @typescript-eslint/no-unused-vars
      return { ...rest, ...(rest.filename ? { filename: noQuery(rest.filename) } : {}), ...(rest.abs_path ? { abs_path: noQuery(rest.abs_path) } : {}) };
    }),
  };
}

const cleanValues = (block: Loose | undefined) =>
  block && Array.isArray(block.values)
    ? {
        ...block,
        values: block.values.map((v: Loose) => ({
          ...v,
          ...(v.type !== undefined ? { type: text(v.type, 120) } : {}),
          ...(v.value !== undefined ? { value: text(v.value) } : {}),
          ...(v.stacktrace ? { stacktrace: cleanStacktrace(v.stacktrace) } : {}),
          ...(v.mechanism?.data ? { mechanism: { ...v.mechanism, data: redactDeep(v.mechanism.data) } } : {}),
        })),
      }
    : block;

/** What survives when the full filter itself fails: identity and timing, no content at all. */
function minimalEvent(event: Loose | null | undefined): ErrorEvent {
  const e = event ?? {};
  return {
    event_id: e.event_id,
    timestamp: e.timestamp,
    platform: e.platform,
    level: e.level,
    release: e.release,
    environment: e.environment,
    message: 'Event details dropped: the privacy filter could not process them.',
  } as unknown as ErrorEvent;
}

/**
 * The full outbound filter, over the WHOLE event: request (no body, cookies or query
 * string; a header allow-list), user (id only), tags, transaction, message and logentry,
 * fingerprint, server name, exception values and every stack frame (no variables, no
 * source lines), contexts, extra and breadcrumbs, then the credential scrub. Never throws:
 * on any failure it returns a minimal event with no content.
 */
export function sanitizeEvent(event: ErrorEvent): ErrorEvent | null {
  try {
    const e = { ...event } as ErrorEvent & Loose;
    if (e.request) {
      const { data: _d, cookies: _c, query_string: _q, ...req } = e.request as Loose; // eslint-disable-line @typescript-eslint/no-unused-vars
      if (req.url !== undefined) req.url = noQuery(req.url);
      if (req.headers && typeof req.headers === 'object') {
        req.headers = Object.fromEntries(
          Object.entries(req.headers as Record<string, unknown>)
            .filter(([k]) => SAFE_HEADERS.has(k.toLowerCase()))
            .map(([k, v]) => [k, text(v, 200)]),
        );
      }
      e.request = req;
    }
    if (e.user) e.user = e.user.id !== undefined ? { id: String(e.user.id) } : undefined;
    if (e.tags) e.tags = redactDeep(e.tags);
    if (e.transaction !== undefined) e.transaction = noQuery(e.transaction) as string;
    if (e.server_name !== undefined) e.server_name = text(e.server_name, 120) as string;
    if (Array.isArray(e.fingerprint)) e.fingerprint = e.fingerprint.map((f: unknown) => text(f, 200)) as string[];
    if (e.message !== undefined) e.message = text(e.message) as string;
    if (e.logentry) {
      e.logentry = {
        ...e.logentry,
        ...(e.logentry.message !== undefined ? { message: text(e.logentry.message) as string } : {}),
        ...(e.logentry.params !== undefined ? { params: redactDeep(e.logentry.params) } : {}),
      };
    }
    if (e.exception) e.exception = cleanValues(e.exception) as typeof e.exception;
    if (e.threads) e.threads = cleanValues(e.threads) as typeof e.threads;
    if (e.extra) e.extra = redactDeep(e.extra);
    if (e.contexts) e.contexts = redactDeep(e.contexts);
    if (e.breadcrumbs) {
      e.breadcrumbs = e.breadcrumbs.map((b: Breadcrumb) => ({
        ...b,
        ...(b.message !== undefined ? { message: text(b.message) as string } : {}),
        ...(b.data ? { data: redactDeep(b.data) } : {}),
      }));
    }
    return scrubEvent(e);
  } catch {
    return minimalEvent(event as unknown as Loose);
  }
}

const rate = (raw: string | undefined) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
};

const release = process.env.COMMIT_REF || process.env.VERCEL_GIT_COMMIT_SHA || undefined;
const environment =
  process.env.CONTEXT || process.env.VERCEL_ENV || process.env.NODE_ENV || undefined;

export const sentryOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  sendDefaultPii: false,
  ...(release ? { release } : {}),
  ...(environment ? { environment } : {}),
  // Errors only unless explicitly raised; the client reads the NEXT_PUBLIC_ spelling.
  tracesSampleRate: rate(process.env.SENTRY_TRACES_SAMPLE_RATE ?? process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE),
  beforeSend: (event: ErrorEvent) => sanitizeEvent(event),
  beforeBreadcrumb: (crumb: Breadcrumb) => {
    const c = scrubBreadcrumb(crumb);
    return c ? redactDeep(c) : null;
  },
};
