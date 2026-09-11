/**
 * Deployment health check.
 *
 * Reports whether each piece of configuration is visible to the *runtime*, which is a
 * different question from whether it's set in a dashboard — build scope, function scope
 * and deploy context can each hide a value that looks present elsewhere.
 *
 * Anyone gets `ok`. The detail needs CRON_SECRET (as `x-cron-secret` or a bearer token):
 * it used to be public, and told strangers the length of AUTH_SECRET and DATABASE_URL,
 * which providers are wired up and whether cron was enabled. No secret value is returned
 * even then.
 */

import { availableProviders } from '@/lib/ai/models';
import { isDatabaseConfigured } from '@/lib/db';
import { getSiteUrl } from '@/lib/site-url';
import { isEncryptionConfigured } from '@/lib/auth/secret-box';
import { isGitHubAppConfigured } from '@/lib/github/app';
import { isMailConfigured, mailProvider } from '@/lib/auth/mail';
import { DRAFT_TIME_BUDGET_MS, RENDER_RESERVE_MS } from '@/lib/ai/budget';
import { DEFAULT_ATTEMPT_TIMEOUT_MS } from '@/lib/ai/chain';
import { ASSESS_TIME_BUDGET_MS } from '@/lib/pipeline/run';
import { cronAuthorized } from '@/lib/server/cron-auth';
import { ownerUserIds } from '@/lib/ai/daily-budget';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function present(key: string): { set: boolean } {
  return { set: Boolean(process.env[key]?.trim()) };
}

export async function GET(req: NextRequest) {
  const auth = {
    AUTH_SECRET: present('AUTH_SECRET'),
    AUTH_GITHUB_ID: present('AUTH_GITHUB_ID'),
    AUTH_GITHUB_SECRET: present('AUTH_GITHUB_SECRET'),
  };

  const authReady =
    auth.AUTH_SECRET.set && auth.AUTH_GITHUB_ID.set && auth.AUTH_GITHUB_SECRET.set;

  const ok = authReady && isDatabaseConfigured && availableProviders().length > 0;
  if (!cronAuthorized(req)) return Response.json({ ok });

  return Response.json({
    ok,
    /**
     * The clocks every request runs against, as the runtime actually resolved them. Each
     * one is a variable nobody could see from outside, and a lost one was an outage.
     */
    limits: {
      draftMs: DRAFT_TIME_BUDGET_MS,
      assessMs: ASSESS_TIME_BUDGET_MS,
      renderReserveMs: RENDER_RESERVE_MS,
      attemptTimeoutMs: DEFAULT_ATTEMPT_TIMEOUT_MS,
    },
    siteUrl: getSiteUrl(),
    platform: {
      netlify: Boolean(process.env.NETLIFY),
      vercel: Boolean(process.env.VERCEL),
      context: process.env.CONTEXT ?? null,
      branch: process.env.BRANCH ?? null,
      nodeEnv: process.env.NODE_ENV,
    },
    auth: { ...auth, ready: authReady },
    database: {
      DATABASE_URL: present('DATABASE_URL'),
      usable: isDatabaseConfigured,
    },
    ai: {
      providers: availableProviders().map((p) => p.label),
      count: availableProviders().length,
    },
    /**
     * Token encryption is reported because its failure mode is silent: with no key,
     * everything keeps working and the GitHub tokens sit in the database in the clear.
     * A boolean here is the difference between noticing that and not.
     */
    security: {
      tokenEncryption: isEncryptionConfigured(),
      cronEnabled: present('CRON_SECRET').set,
      /**
       * With a GitHub App configured, sign-in stops asking for `repo` — read and write
       * on every repository the user owns — and repository access becomes a token minted
       * per request instead of a credential stored here.
       */
      githubApp: isGitHubAppConfigured(),
      githubOAuthScope: isGitHubAppConfigured()
        ? 'read:user user:email read:org'
        : 'read:user user:email read:org repo',
    },
    budget: {
      // How many accounts sit outside the shared daily pool — a count, never the addresses.
      ownerAccounts: (await ownerUserIds()).length,
    },
    mail: {
      configured: isMailConfigured(),
      provider: mailProvider(),
    },
    optional: {
      FIRECRAWL_API_KEY: present('FIRECRAWL_API_KEY').set,
      GITHUB_WEBHOOK_SECRET: present('GITHUB_WEBHOOK_SECRET').set,
    },
  });
}
