/**
 * Hourly draft-failure alert, ops alerts and the light housekeeping pass - called by
 * netlify/functions/draft-alerts.mts.
 *
 * The tidying rides along with the alert rather than being a second schedule. The full
 * retention sweep is its own daily job (/api/cron/housekeeping).
 *
 * Draft alerts: lib/server/draft-alerts.ts (clock-hour windows, so overlapping runs cannot
 * double-send). Ops alerts (credits low, stuck radar runs, database unreachable) are
 * de-duplicated per kind for 24h with an atomic claim in app_setting, so an hourly doorbell
 * does not mail the same condition every hour. `?dryRun=1` reports without sending.
 */

import type { NextRequest } from 'next/server';
import { cronAuthorized } from '@/lib/server/cron-auth';
import { runDraftAlerts } from '@/lib/server/draft-alerts';
import {
  claimAlert,
  collectOpsFindings,
  composeOpsAlert,
  recordHeartbeat,
  runHousekeeping,
  type OpsFinding,
} from '@/lib/server/housekeeping';
import { appUrl, isMailConfigured, sendOperatorEmail } from '@/lib/auth/mail';
import { log } from '@/lib/log';

export const runtime = 'nodejs';

async function sendOpsAlerts(dryRun: boolean): Promise<{ findings: OpsFinding[]; sent: boolean }> {
  const all = await collectOpsFindings();
  const fresh: OpsFinding[] = [];
  for (const f of all) if (dryRun || (await claimAlert(f.kind))) fresh.push(f);
  const mail = composeOpsAlert(fresh);
  const to = process.env.ALERT_EMAIL?.trim();
  if (!mail || dryRun || !to || !isMailConfigured()) return { findings: all, sent: false };
  const result = await sendOperatorEmail(to, mail.subject, `${mail.text}\n\n${appUrl('/api/health')}`);
  if (!result.ok) log.error('ops alert not sent', { route: '/api/cron/alerts', err: result.error });
  return { findings: all, sent: result.ok };
}

async function run(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: 'CRON_SECRET is not set, so alerts are disabled.' }, { status: 501 });
  }
  if (!cronAuthorized(req)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const ops = await sendOpsAlerts(dryRun).catch((err) => {
    log.error('ops checks failed', { route: '/api/cron/alerts', err });
    return { findings: [] as OpsFinding[], sent: false };
  });
  // With the database down this throws; the ops alert above has already gone out, and the
  // route still answers JSON rather than a bare 500 so the doorbell logs something useful.
  const alerts = await runDraftAlerts(new Date(), { dryRun }).catch((err) => {
    log.error('draft alerts failed', { route: '/api/cron/alerts', err });
    return { error: 'draft alerts failed' };
  });
  const housekeeping = dryRun ? null : await runHousekeeping(new Date(), { scope: 'hourly' }).catch(() => null);
  if (!dryRun && !('error' in alerts)) await recordHeartbeat('alerts');
  return Response.json({ ...alerts, ops, housekeeping });
}

export const POST = run;
export const GET = run;
