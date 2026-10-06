/**
 * Job Radar HTTP handlers, built from injected dependencies so they can be tested without a
 * session, a database or Next. app/api/radar/route.ts wires the real ones (a Next route file
 * may not export anything but its handlers, hence this file).
 *
 * Order on every request: signed in (401) -> approved by the owner (403) -> for POST, same
 * origin (403), JSON content type (415), small body (413), strict shape (400). Every lib call
 * takes the session's userId and filters on it, so another user's run is indistinguishable
 * from a missing one (404).
 */

import { z } from 'zod';
import { BudgetExceededError } from '@/lib/ai/budget';
import { authoredMessage } from '@/lib/server/user-message';
import type { RadarStatus } from './events';

export interface RadarHandlerDeps {
  userId(): Promise<string | null>;
  approval(userId: string): Promise<string>;
  assertBurst(userId: string): Promise<void>;
  credits(): Promise<object>;
  /** Hostnames besides the request's own that count as this site (AUTH_URL's). */
  extraHosts?: string[];
  start(userId: string, o: { intel?: boolean }): Promise<RadarStatus>;
  advance(userId: string, runId: string, expectStep: number): Promise<RadarStatus>;
  approve(userId: string, runId: string, queries: Array<string | { q: string; why?: string }>): Promise<RadarStatus>;
  select(userId: string, runId: string, key: string): Promise<RadarStatus & { jobText: string }>;
  cancel(userId: string, runId: string): Promise<RadarStatus>;
  get(userId: string, runId?: string): Promise<RadarStatus | null>;
}

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const MAX_BODY_BYTES = 8 * 1024;

const runId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const query = z.union([
  z.string().max(120),
  z.object({ q: z.string().max(120), why: z.string().max(200).optional() }).strict(),
]);
const Body = z.union([
  z.object({ intel: z.boolean().optional() }).strict(),
  z.object({ runId, expectStep: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ runId, action: z.literal('approve'), queries: z.array(query).min(1).max(3) }).strict(),
  z.object({ runId, action: z.literal('select'), key: z.string().min(1).max(64) }).strict(),
  z.object({ runId, action: z.literal('cancel') }).strict(),
]);

const MISSING_TABLE_MESSAGE =
  'Job Radar needs its database tables. Run npm run db:push (or apply scripts/2026-10-06-job-radar.sql).';

/** Postgres "undefined_table" for one of ours, however the driver wrapped it. */
export function isMissingTable(err: unknown): boolean {
  let e = err as { code?: unknown; message?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; e && depth < 4; depth++) {
    if (e.code === '42P01') return true;
    if (typeof e.message === 'string' && /relation "?(agent_run|serp_cache)"? does not exist/.test(e.message)) return true;
    e = e.cause as typeof e;
  }
  return false;
}

function fail(err: unknown) {
  if (isMissingTable(err)) return json({ error: MISSING_TABLE_MESSAGE }, 503);
  if (err instanceof BudgetExceededError) return json({ error: err.message }, 429);
  const message = authoredMessage(err, 'Job Radar hit a problem. Try again in a minute.');
  if (message === 'That run was not found.') return json({ error: message }, 404);
  if (message.startsWith("You have used today's")) return json({ error: message }, 429);
  // A plain Error from lib/radar is a sentence written for the user (bad key, no queries...).
  const authored = err instanceof Error && err.constructor === Error;
  return json({ error: message }, authored ? 400 : 500);
}

const WAITING = { error: 'Your account is waiting for approval.' };

function sameOrigin(req: Request, extraHosts: string[]): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true; // not a browser cross-site request
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const allowed = [req.headers.get('host'), req.headers.get('x-forwarded-host'), ...extraHosts]
    .flatMap((h) => (h ? h.split(',') : []))
    .map((h) => h.trim().toLowerCase());
  return allowed.includes(host);
}

export function makeRadarHandlers(deps: RadarHandlerDeps) {
  /** The session's user if signed in and approved, else the response to send. */
  async function gate(): Promise<{ userId: string } | { res: Response }> {
    const userId = await deps.userId();
    if (!userId) return { res: json({ error: 'Sign in first.' }, 401) };
    if ((await deps.approval(userId)) !== 'approved') return { res: json(WAITING, 403) };
    return { userId };
  }

  async function GET(req: Request) {
    try {
      const g = await gate();
      if ('res' in g) return g.res;
      const { userId } = g;
      const p = new URL(req.url).searchParams;
      if (p.get('credits')) return json({ ...(await deps.credits()) });
      const id = p.get('runId');
      if (id !== null && !runId.safeParse(id).success) return json({ error: 'Invalid run id.' }, 400);
      const run = await deps.get(userId, id ?? undefined);
      if (id && !run) return json({ error: 'That run was not found.' }, 404);
      return json({ run });
    } catch (err) {
      console.error('[radar] read failed', err);
      return fail(err);
    }
  }

  async function POST(req: Request) {
    try {
      const g = await gate();
      if ('res' in g) return g.res;
      const { userId } = g;

      if (!sameOrigin(req, deps.extraHosts ?? [])) return json({ error: 'That request came from another site.' }, 403);
      if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
        return json({ error: 'Send JSON.' }, 415);
      }
      const declared = Number(req.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json({ error: 'That request is too large.' }, 413);
      const text = await req.text();
      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ error: 'That request is too large.' }, 413);

      let raw: unknown = {};
      if (text.trim()) {
        try {
          raw = JSON.parse(text);
        } catch {
          return json({ error: 'That request was not valid.' }, 400);
        }
      }
      const parsed = Body.safeParse(raw ?? {});
      if (!parsed.success) return json({ error: 'That request was not valid.' }, 400);
      const b = parsed.data;

      await deps.assertBurst(userId);
      if (!('runId' in b)) return json(await deps.start(userId, { intel: b.intel }));
      if ('expectStep' in b) return json(await deps.advance(userId, b.runId, b.expectStep));
      if (b.action === 'approve') return json(await deps.approve(userId, b.runId, b.queries));
      if (b.action === 'select') return json(await deps.select(userId, b.runId, b.key));
      return json(await deps.cancel(userId, b.runId));
    } catch (err) {
      console.error('[radar] request failed', err);
      return fail(err);
    }
  }

  return { GET, POST };
}
