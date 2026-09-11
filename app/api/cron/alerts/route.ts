/**
 * Hourly draft-failure alert and housekeeping — called by netlify/functions/draft-alerts.mts.
 *
 * The tidying rides along with the alert rather than being a second schedule: it is two
 * deletes, it has to happen somewhere, and this job already runs every hour.
 *
 * All the logic is in lib/server/draft-alerts.ts; this only checks the secret. `?dryRun=1`
 * reports what would be sent without sending it, so the wiring can be checked by hand
 * without mailing anyone.
 */

import type { NextRequest } from 'next/server';
import { cronAuthorized } from '@/lib/server/cron-auth';
import { runDraftAlerts } from '@/lib/server/draft-alerts';
import { runHousekeeping } from '@/lib/server/housekeeping';

export const runtime = 'nodejs';

async function run(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: 'CRON_SECRET is not set, so alerts are disabled.' }, { status: 501 });
  }
  if (!cronAuthorized(req)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const alerts = await runDraftAlerts(new Date(), { dryRun });
  const housekeeping = dryRun ? null : await runHousekeeping();
  return Response.json({ ...alerts, housekeeping });
}

export const POST = run;
export const GET = run;
