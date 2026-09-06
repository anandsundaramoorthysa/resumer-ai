/**
 * Daily portfolio-freshness trigger — task 3.7.
 *
 * This function is a doorbell, not a worker. It makes one authenticated request to
 * /api/cron/sync and reports what came back; all of the logic, the database access and
 * the bounding live in that route, where the app's own configuration already is.
 *
 * Two reasons it is shaped this way. A scheduled Netlify function runs under the same
 * duration ceiling as any other (10s non-streaming), so it must not be where long work
 * happens — and a portfolio sync is minutes long, driven step by step by a client that a
 * cron does not have. So the daily job only invalidates the cached commit SHA where the
 * repo has moved; the sync itself still happens with a person watching it.
 *
 * Requires CRON_SECRET to be set in the site's environment. Without it the route refuses
 * to run at all, which is deliberate — an unauthenticated endpoint that walks every
 * user's GitHub token is not something to leave enabled by accident.
 */

/**
 * Declared locally rather than imported from `@netlify/functions`. The package is not a
 * dependency of this project, and pulling one in for a single type — on a platform the
 * README already recommends against deploying to — is not a trade worth making. Netlify
 * reads the `schedule` string off this export at build time; the shape is the contract.
 */
interface ScheduledFunctionConfig {
  schedule: string;
}

export default async function handler(): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn('[daily-sync] CRON_SECRET is not set — skipping.');
    return new Response('CRON_SECRET not configured', { status: 200 });
  }

  const base = (process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? '').replace(/\/$/, '');
  if (!base) {
    console.warn('[daily-sync] No site URL in the environment — skipping.');
    return new Response('No site URL', { status: 200 });
  }

  try {
    const res = await fetch(`${base}/api/cron/sync`, {
      method: 'POST',
      headers: { 'x-cron-secret': secret },
    });
    const body = await res.text();
    console.log(`[daily-sync] ${res.status} ${body.slice(0, 300)}`);
    // Always 200: a failing downstream check is worth logging, not worth Netlify
    // retrying — the next run is tomorrow and the SHA gate is idempotent either way.
    return new Response(body, { status: 200 });
  } catch (err) {
    console.error('[daily-sync] request failed:', err);
    return new Response('trigger failed', { status: 200 });
  }
}

export const config: ScheduledFunctionConfig = {
  // 04:15 UTC — off the hour, because every free-tier scheduler in the world fires on it.
  schedule: '15 4 * * *',
};
