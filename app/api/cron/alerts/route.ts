/**
 * Hourly draft-failure alert — called by netlify/functions/draft-alerts.mts.
 *
 * All the logic is in lib/server/draft-alerts.ts; this only checks the secret. `?dryRun=1`
 * reports what would be sent without sending it, so the wiring can be checked by hand
 * without mailing anyone.
 */

import type { NextRequest } from 'next/server';
import { cronAuthorized } from '@/lib/server/cron-auth';
import { runDraftAlerts } from '@/lib/server/draft-alerts';

export const runtime = 'nodejs';

async function run(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: 'CRON_SECRET is not set, so alerts are disabled.' }, { status: 501 });
  }
  if (!cronAuthorized(req)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  return Response.json(await runDraftAlerts(new Date(), { dryRun }));
}

export const POST = run;
export const GET = run;
