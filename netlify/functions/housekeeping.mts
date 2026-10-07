/**
 * Daily retention sweep trigger - the doorbell for /api/cron/housekeeping.
 *
 * Same shape as daily-sync.mts: one authenticated request, the route does the work (batched
 * deletes under an 8s budget; a run cut short continues tomorrow). Always answers 200 so
 * Netlify does not retry - the sweep is idempotent, but a retry adds nothing.
 * Needs CRON_SECRET. Optional dead-man's-switch: HEARTBEAT_URL_HOUSEKEEPING.
 */

import { log, pingHeartbeat } from '../../lib/log';

const lg = log.child({ job: 'housekeeping' });

interface ScheduledFunctionConfig {
  schedule: string;
}

export default async function handler(): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const base = (process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? '').replace(/\/$/, '');
  if (!secret || !base) {
    lg.warn('CRON_SECRET or site URL missing, skipping');
    return new Response('not configured', { status: 200 });
  }

  try {
    const res = await fetch(`${base}/api/cron/housekeeping`, {
      method: 'POST',
      headers: { 'x-cron-secret': secret },
    });
    const body = await res.text();
    lg.info('triggered', { status: res.status, body: body.slice(0, 300) });
    await pingHeartbeat('housekeeping', res.ok);
    return new Response(body, { status: 200 });
  } catch (err) {
    lg.error('request failed', { err });
    await pingHeartbeat('housekeeping', false);
    return new Response('trigger failed', { status: 200 });
  }
}

export const config: ScheduledFunctionConfig = {
  // 03:30 UTC, off the hour and clear of the 04:15 portfolio check.
  schedule: '30 3 * * *',
};
