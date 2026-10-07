/**
 * Deployment health check.
 *
 * Reports whether each piece of configuration is visible to the *runtime*, which is a
 * different question from whether it's set in a dashboard — build scope, function scope
 * and deploy context can each hide a value that looks present elsewhere.
 *
 * Anyone gets `{status:'ok'}` (200) or `{status:'degraded'}` (503) from a `select 1` with a 2s
 * timeout - nothing about configuration. The detail needs CRON_SECRET (as `x-cron-secret` or a bearer token):
 * it used to be public, and told strangers the length of AUTH_SECRET and DATABASE_URL,
 * which providers are wired up and whether cron was enabled. No secret value is returned
 * even then.
 */

import { sql } from 'drizzle-orm';
import { availableProviders } from '@/lib/ai/models';
import { db, isDatabaseConfigured } from '@/lib/db';
import { validateEnv } from '@/lib/env';
import { log } from '@/lib/log';
import { lastHeartbeats } from '@/lib/server/housekeeping';
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

const NO_STORE = { 'Cache-Control': 'no-store' };
const TABLES = ['agent_run', 'serp_cache', 'user_consent', 'invite_code', 'ai_call', 'app_setting'];

/** Runs `work`, rejecting after `ms`. The losing query is left to finish on its own. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

const rows = (r: unknown): Array<Record<string, unknown>> =>
  Array.isArray(r) ? r : ((r as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? []);

/** Cheap deep checks, each independently guarded so one failure cannot hide the rest. */
async function deepChecks() {
  const started = Date.now();
  const [tables, stuck, heartbeats, models, serp] = await Promise.all([
    within(
      3000,
      db.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_name in (${sql.join(TABLES.map((t) => sql`${t}`), sql`, `)})`,
      ),
    )
      .then((r) => {
        const have = new Set(rows(r).map((x) => String(x.table_name)));
        return Object.fromEntries(TABLES.map((t) => [t, have.has(t)]));
      })
      .catch(() => null),
    within(3000, db.execute(sql`select count(*)::int as n from agent_run where status in ('running','awaiting') and updated_at < now() - interval '30 minutes'`))
      .then((r) => Number(rows(r)[0]?.n ?? 0))
      .catch(() => null),
    within(3000, lastHeartbeats()).catch(() => ({})),
    (async () => {
      const [m, c] = await Promise.all([import('@/lib/ai/models').catch(() => null), import('@/lib/ai/chain').catch(() => null)]);
      return {
        providers: m?.describeModelConfig?.() ?? null,
        modelGone: c?.modelGoneProviders?.() ?? null,
      };
    })().catch(() => null),
    (async () => {
      const mod = await import('@/lib/serp/client').catch(() => null);
      return mod?.creditStatus ? await within(3000, mod.creditStatus()) : null;
    })().catch(() => null),
  ]);
  return {
    tables,
    stuckRadarRuns: stuck,
    heartbeats,
    models,
    serp: serp && { mode: serp.mode, creditsLeft: serp.left, unavailable: serp.unavailable },
    checksMs: Date.now() - started,
  };
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

  const t0 = Date.now();
  const dbUp = isDatabaseConfigured
    ? await within(2000, db.execute(sql`select 1`)).then(
        () => true,
        () => false,
      )
    : false;
  const dbLatencyMs = Date.now() - t0;
  if (!dbUp) log.warn('health degraded: database unreachable', { route: '/api/health', latencyMs: dbLatencyMs });

  if (!cronAuthorized(req)) {
    return Response.json({ status: dbUp ? 'ok' : 'degraded' }, { status: dbUp ? 200 : 503, headers: NO_STORE });
  }
  const deep = dbUp ? await deepChecks() : null;

  return Response.json({
    status: dbUp ? 'ok' : 'degraded',
    ok,
    release: process.env.COMMIT_REF ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    env: validateEnv(),
    db: { up: dbUp, latencyMs: dbLatencyMs },
    deep,
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
      ownerAccounts: dbUp ? await ownerUserIds().then((x) => x.length, () => null) : null,
    },
    mail: {
      configured: isMailConfigured(),
      provider: mailProvider(),
    },
    optional: {
      FIRECRAWL_API_KEY: present('FIRECRAWL_API_KEY').set,
      GITHUB_WEBHOOK_SECRET: present('GITHUB_WEBHOOK_SECRET').set,
    },
  }, { headers: NO_STORE });
}
