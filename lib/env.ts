/**
 * Environment validation — `validateEnv(process.env)` returns what is missing; it never
 * throws and nothing calls it at import time, so a build without secrets still succeeds.
 *
 * The result lists variable NAMES only, never values. Used by /api/health (detail mode).
 * The required/optional matrix is documented in docs/production/OPERATIONS.md.
 */

import { z } from 'zod';

const set = z.string().trim().min(1);
const unset = z.string().optional();

/** Without these the app cannot sign anyone in or store anything. */
export const REQUIRED_VARS = [
  'DATABASE_URL',
  'AUTH_SECRET',
  'AUTH_GITHUB_ID',
  'AUTH_GITHUB_SECRET',
  'TOKEN_ENC_KEY',
  'NEXT_PUBLIC_SITE_URL',
] as const;

/** Missing -> a feature is off or degraded, listed as a warning. */
export const OPTIONAL_VARS = [
  'CRON_SECRET', // scheduled jobs refuse to run without it
  'ALERT_EMAIL', // alerts have nowhere to go
  'SMTP_USER',
  'SMTP_PASS', // no email: verification, reset, approval notices all silently drop
  'OWNER_EMAILS', // nobody can open /admin/*
  'NEXT_PUBLIC_SENTRY_DSN',
  'SERPAPI_API_KEY', // radar runs in replay mode
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'FIRECRAWL_API_KEY',
] as const;

/** At least one must be set, or no draft can run. */
export const AI_PROVIDER_KEYS = [
  'GROQ_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'DEEPINFRA_API_KEY',
] as const;

export const envSchema = z.object({
  ...Object.fromEntries(REQUIRED_VARS.map((k) => [k, set])),
  ...Object.fromEntries(OPTIONAL_VARS.map((k) => [k, unset])),
  ...Object.fromEntries(AI_PROVIDER_KEYS.map((k) => [k, unset])),
});

export interface EnvReport {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

export function validateEnv(env: Record<string, string | undefined> = process.env): EnvReport {
  const missing: string[] = [];
  const warnings: string[] = [];
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if ((REQUIRED_VARS as readonly string[]).includes(key) && !missing.includes(key)) missing.push(key);
    }
  }
  if (!AI_PROVIDER_KEYS.some((k) => env[k]?.trim())) missing.push('one of ' + AI_PROVIDER_KEYS.join(' | '));

  for (const k of OPTIONAL_VARS) if (!env[k]?.trim()) warnings.push(`${k} is not set`);
    if (env.NODE_ENV === 'production' && /localhost|127\.0\.0\.1/.test(env.NEXT_PUBLIC_SITE_URL ?? '')) {
    warnings.push('NEXT_PUBLIC_SITE_URL points at localhost in production');
  }
  if (env.AUTH_SECRET && env.AUTH_SECRET.trim().length > 0 && env.AUTH_SECRET.trim().length < 16) {
    warnings.push('AUTH_SECRET is shorter than 16 characters');
  }
  return { ok: missing.length === 0, missing, warnings };
}
