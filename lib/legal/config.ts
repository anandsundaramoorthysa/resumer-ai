/**
 * The one place the legal, grievance and access-policy facts live. Changing the grievance
 * officer, the effective date or a retention period is a one-line edit here; every legal
 * page, the consent record and the emails read from this file.
 *
 * Env (read at call time, documented here because .env.example belongs to another change):
 *   SIGNUP_MODE             'invite' (default) | 'open' | 'manual'
 *                             invite  a valid invite code auto-approves, under the daily quota;
 *                                     no code means the owner approves by hand
 *                             open    every new account is auto-approved under the daily quota
 *                             manual  codes are ignored; the owner approves everyone
 *   AUTO_APPROVE_DAILY_QUOTA  accounts that may be auto-approved per IST day (default 20)
 *
 * Bump POLICY_VERSION or TERMS_VERSION when the text changes materially: every user who has
 * not accepted the CURRENT POLICY_VERSION is sent to /consent on their next visit.
 */

export const APP_NAME = 'Resumer AI';

export const POLICY_VERSION = '2026-10-08';
export const TERMS_VERSION = '2026-10-07';
export const EFFECTIVE_DATE = '8 October 2026';

export const OPERATOR = {
  name: 'Anand Sundaramoorthy',
  status: 'sole proprietor (individual), India',
} as const;

export const GRIEVANCE = {
  name: 'Anand Sundaramoorthy',
  title: 'Grievance Officer',
  email: 'sanand03072005@gmail.com',
  acknowledgeDays: 7,
  resolveDays: 30,
} as const;

/** Support and security reports go to the same mailbox until the owner sets up another. */
export const SUPPORT_EMAIL = GRIEVANCE.email;
export const SECURITY_EMAIL = GRIEVANCE.email;

/** PLACEHOLDER: counsel must confirm the venue before launch (see docs/production/LEGAL-REVIEW.md). */
export const JURISDICTION_CITY = 'Chennai, Tamil Nadu';

/** Retention (days). The cleanup jobs are implemented separately; the notice states these. */
export const RETENTION = {
  runHistoryDays: 90,
  radarRunDays: 30,
  searchCacheHours: 24,
  searchCacheMaxDays: 30,
  deniedAccountDays: 30,
  inactiveAccountMonths: 24,
  aiCallDays: 90,
  auditLogMonths: 12,
  auditPromptDays: 90,
  backupPurgeDays: 30,
  usageCountsMonths: 12,
} as const;

export const MIN_AGE = 18;

/** What an API call without a current consent record is told (HTTP 403 / BudgetExceededError). */
export const CONSENT_REQUIRED_MESSAGE = 'Please accept the Terms and Privacy Policy to continue.';

/** ASSUMPTION stated in the privacy notice: which Google Gemini API tier the service's key is on. Change if upgraded. */
export const GEMINI_TIER = 'unpaid' as 'unpaid' | 'paid';

export type SignupMode = 'invite' | 'open' | 'manual';

export function signupMode(): SignupMode {
  const v = process.env.SIGNUP_MODE?.trim().toLowerCase();
  return v === 'open' || v === 'manual' ? v : 'invite';
}

export function autoApproveDailyQuota(): number {
  const n = Number(process.env.AUTO_APPROVE_DAILY_QUOTA);
  return Number.isFinite(n) && n >= 0 && process.env.AUTO_APPROVE_DAILY_QUOTA?.trim() ? Math.floor(n) : 20;
}

export const LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/contact', label: 'Contact' },
  { href: '/accessibility', label: 'Accessibility' },
] as const;
