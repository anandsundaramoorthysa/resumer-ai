/**
 * Daily retention sweep - called by netlify/functions/housekeeping.mts at 03:30 UTC.
 *
 * All logic is in lib/server/housekeeping.ts; this checks CRON_SECRET (timing-safe, same as
 * the other cron routes) and returns the counts. `?scope=hourly` runs only the cheap pass.
 * Idempotent: calling it twice, or by hand, is safe.
 */

import type { NextRequest } from 'next/server';
import { cronAuthorized } from '@/lib/server/cron-auth';
import { recordHeartbeat, runHousekeeping } from '@/lib/server/housekeeping';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const maxDuration = 30;

async function run(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: 'CRON_SECRET is not set, so housekeeping is disabled.' }, { status: 501 });
  }
  if (!cronAuthorized(req)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const scope = req.nextUrl.searchParams.get('scope') === 'hourly' ? 'hourly' : 'daily';
  const out = await runHousekeeping(new Date(), { scope });
  log.info('housekeeping', { route: '/api/cron/housekeeping', scope, ...out });
  if (out.errors.length === 0) await recordHeartbeat('housekeeping');
  return Response.json(out);
}

export const POST = run;
export const GET = run;
