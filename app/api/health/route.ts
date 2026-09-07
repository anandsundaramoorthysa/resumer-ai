/**
 * Deployment health check.
 *
 * Reports whether each piece of configuration is visible to the *runtime*, which is a
 * different question from whether it's set in a dashboard — build scope, function scope
 * and deploy context can each hide a value that looks present elsewhere.
 *
 * Booleans and lengths only. No secret value is ever returned, so this is safe to leave
 * enabled in production, where it's the fastest way to tell a config problem apart from
 * a code problem.
 */

import { availableProviders } from '@/lib/ai/models';
import { isDatabaseConfigured } from '@/lib/db';
import { getSiteUrl } from '@/lib/site-url';
import { isEncryptionConfigured } from '@/lib/auth/secret-box';
import { isGitHubAppConfigured } from '@/lib/github/app';
import { isMailConfigured, mailProvider } from '@/lib/auth/mail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function present(key: string): { set: boolean; length: number } {
  const v = process.env[key];
  return { set: Boolean(v && v.trim()), length: v ? v.trim().length : 0 };
}

export async function GET() {
  const auth = {
    AUTH_SECRET: present('AUTH_SECRET'),
    AUTH_GITHUB_ID: present('AUTH_GITHUB_ID'),
    AUTH_GITHUB_SECRET: present('AUTH_GITHUB_SECRET'),
  };

  const authReady =
    auth.AUTH_SECRET.set && auth.AUTH_GITHUB_ID.set && auth.AUTH_GITHUB_SECRET.set;

  return Response.json({
    ok: authReady && isDatabaseConfigured && availableProviders().length > 0,
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
        ? 'read:user user:email'
        : 'read:user user:email repo',
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
