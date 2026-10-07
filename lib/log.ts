/**
 * Tiny structured logger: one JSON line per event on stdout/stderr, which is what
 * Netlify's function log (and any drain) indexes. Server-only (AsyncLocalStorage).
 *
 *   import { log, withRequestId } from '@/lib/log';
 *   log.info('swept', { count: 3 });                   // {"ts":..,"level":"info","msg":"swept","count":3}
 *   const l = log.child({ route: '/api/cron/alerts' });
 *   await withRequestId(id, () => handler());          // every line inside carries requestId
 *
 * Free text is scrubbed (emails, phones, bearer tokens, api_key=..., long tokens) because
 * messages sometimes quote resume or job text. userId is hashed, never logged raw.
 *
 * CODEMOD NOTE: the app still has ~100 bare console.error/warn calls (grep
 * "console\.(error|warn|log)\(" app lib). Replace them file by file with
 * `log.error('what failed', { err })` / `log.warn(...)`; `err` is serialised for you
 * (name, message, stack truncated to 8 lines). Sentry's captureConsole integration reports
 * console.error today, so migrate a file together with a Sentry.captureException call
 * where the error should still alert (log.error does NOT go to Sentry by itself).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { redactText } from './sentry-options';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Fields = Record<string, unknown> & {
  requestId?: string;
  route?: string;
  userId?: string;
  err?: unknown;
};

const als = new AsyncLocalStorage<{ requestId: string }>();

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return als.run({ requestId }, fn);
}
export const currentRequestId = (): string | undefined => als.getStore()?.requestId;

/** Stable, non-reversible id for correlating one user's lines. */
export function hashUserId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

const SECRET_KEY = /(secret|token|password|authorization|cookie|api[_-]?key|private)/i;

export function serializeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: redactText(err.message, 300),
      ...(err.stack ? { stack: redactText(err.stack.split('\n').slice(0, 8).join('\n'), 1200) } : {}),
    };
  }
  return { name: 'NonError', message: redactText(String(err), 300) };
}

function clean(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, 1000);
  if (value instanceof Error) return serializeError(value);
  if (depth > 3 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : clean(v, depth + 1);
  }
  return out;
}

const threshold = (): number =>
  ORDER[(process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : 'info'];

/** Builds the line without writing it; exported for tests. */
export function formatLine(level: Level, msg: string, fields: Fields = {}, now = new Date()): string {
  const { err, userId, ...rest } = fields;
  const entry: Record<string, unknown> = {
    ts: now.toISOString(),
    level,
    msg: redactText(msg, 500),
    requestId: fields.requestId ?? currentRequestId(),
  };
  for (const [k, v] of Object.entries(rest)) if (k !== 'requestId') entry[k] = SECRET_KEY.test(k) ? '[redacted]' : clean(v);
  if (userId) entry.userId = hashUserId(userId);
  if (err !== undefined) entry.err = serializeError(err);
  return JSON.stringify(entry);
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(bound: Fields): Logger;
}

function make(bound: Fields): Logger {
  const emit = (level: Level) => (msg: string, fields?: Fields) => {
    if (ORDER[level] < threshold()) return;
    const line = formatLine(level, msg, { ...bound, ...fields });
    // stderr for warn/error so platforms that split streams tag severity correctly.
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (extra) => make({ ...bound, ...extra }),
  };
}

export const log: Logger = make({});

/**
 * Dead-man's-switch ping for a scheduled function (Healthchecks.io style), awaited but
 * bounded to 3s and never throwing. URL comes from HEARTBEAT_URL_<NAME> (name upper-cased,
 * '-' -> '_') or `${HEALTHCHECKS_BASE_URL}/<name>`; `/fail` is appended on failure. The URL
 * is a secret-ish capability link, so it is never logged - only the name and outcome.
 */
export async function pingHeartbeat(name: string, ok: boolean): Promise<void> {
  const env = process.env[`HEARTBEAT_URL_${name.toUpperCase().replace(/-/g, '_')}`]?.trim();
  const base = process.env.HEALTHCHECKS_BASE_URL?.trim().replace(/\/$/, '');
  const url = env || (base ? `${base}/${name}` : '');
  if (!url) return;
  try {
    await fetch(ok ? url : `${url.replace(/\/$/, '')}/fail`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    log.debug('heartbeat sent', { job: name, ok });
  } catch {
    log.warn('heartbeat failed', { job: name });
  }
}
