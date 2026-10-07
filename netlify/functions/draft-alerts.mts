/**
 * Hourly draft-failure alert trigger — the doorbell for /api/cron/alerts.
 *
 * Same shape as daily-sync.mts, for the same reasons: a scheduled function runs under the
 * 10-second ceiling and outside the app's configuration, so it makes one authenticated
 * request and the route does the work. Needs CRON_SECRET, and ALERT_EMAIL for the email
 * to have somewhere to go.
 */

import { log, pingHeartbeat } from '../../lib/log';

const lg = log.child({ job: 'draft-alerts' });

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
    const res = await fetch(`${base}/api/cron/alerts`, {
      method: 'POST',
      headers: { 'x-cron-secret': secret },
    });
    const body = await res.text();
    lg.info('triggered', { status: res.status, body: body.slice(0, 300) });
    await pingHeartbeat('draft-alerts', res.ok);
    // Always 200: a retry would re-read the same hour and could send the same alert twice.
    return new Response(body, { status: 200 });
  } catch (err) {
    lg.error('request failed', { err });
    await pingHeartbeat('draft-alerts', false);
    return new Response('trigger failed', { status: 200 });
  }
}

export const config: ScheduledFunctionConfig = {
  // Five past each hour, so the hour it reports on has fully closed.
  schedule: '5 * * * *',
};
