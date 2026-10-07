/**
 * Which tables the account export covers, and which are deliberately left out.
 *
 * tests/legal-export.test.mts introspects the Drizzle schema and fails for any table with a
 * foreign key to `user` that appears in neither list, so a new table cannot silently
 * miss the right of access.
 */

import type { PgTable } from 'drizzle-orm/pg-core';
import { aiCall } from '@/lib/db/schema-ai';
import {
  accounts,
  agentRuns,
  aiUsageDaily,
  applicationFormFields,
  applications,
  auditLog,
  contactInfo,
  dismissedRecords,
  draftRuns,
  enrichmentPreferences,
  enrichmentQuestions,
  githubInstallations,
  inviteRedemptions,
  profileRecords,
  resumeSnapshots,
  roles,
  stewardDismissals,
  syncJobs,
  userConsent,
} from '@/lib/db/schema';

export interface ExportEntry {
  /** Key in the JSON file. */
  key: string;
  table: PgTable;
  /** The column holding the user id (a property name of the Drizzle table). */
  userColumn: string;
  /** Property names to include; all columns when omitted. */
  columns?: string[];
  /** True when the entry is a single row per user (exported as an object, not an array). */
  single?: boolean;
}

export const EXPORT_TABLES: ExportEntry[] = [
  { key: 'contact', table: contactInfo, userColumn: 'userId', single: true },
  { key: 'records', table: profileRecords, userColumn: 'userId' },
  { key: 'jobs', table: roles, userColumn: 'userId' },
  // The stored PDFs are re-rendered from the document on demand, so the document is exported.
  { key: 'snapshots', table: resumeSnapshots, userColumn: 'userId' },
  { key: 'applications', table: applications, userColumn: 'userId' },
  { key: 'applicationAnswers', table: applicationFormFields, userColumn: 'userId', single: true },
  { key: 'questions', table: enrichmentQuestions, userColumn: 'userId' },
  { key: 'enrichmentPreference', table: enrichmentPreferences, userColumn: 'userId', single: true },
  { key: 'draftRuns', table: draftRuns, userColumn: 'userId' },
  { key: 'auditLog', table: auditLog, userColumn: 'userId' },
  { key: 'dismissedRecords', table: dismissedRecords, userColumn: 'userId' },
  { key: 'stewardDismissals', table: stewardDismissals, userColumn: 'userId' },
  { key: 'radarRuns', table: agentRuns, userColumn: 'userId' },
  { key: 'syncJobs', table: syncJobs, userColumn: 'userId' },
  { key: 'githubInstallations', table: githubInstallations, userColumn: 'userId' }, // ids only: the schema stores no tokens
  { key: 'aiUsageDaily', table: aiUsageDaily, userColumn: 'userId' },
  { key: 'consent', table: userConsent, userColumn: 'userId' },
  // ai_call has no FK to user by design (telemetry must never block a deletion), so deleteAccount
  // removes it explicitly. Exported trimmed: no ids, no stage or prompt version.
  { key: 'aiCalls', table: aiCall, userColumn: 'userId', columns: ['provider', 'model', 'inTokens', 'outTokens', 'latencyMs', 'errorClass', 'createdAt'] },
  { key: 'inviteRedemption', table: inviteRedemptions, userColumn: 'userId', single: true },
  // Sign-in methods only: never the OAuth tokens that sit in the same table.
  { key: 'signInMethods', table: accounts, userColumn: 'userId', columns: ['type', 'provider'] },
];

/** Tables with a foreign key to `user` that are intentionally not exported, and why. */
export const EXPORT_EXCLUDED: Record<string, string> = {
  session: 'Auth.js session rows; sessions are stateless JWTs and the table is not used. Not personal content.',
  radar_search:
    'Operational ledger of the billable upstream searches of a radar run (reached only through agent_run, so it has no user column). The same queries are in the exported radarRuns state; the rows are deleted with the run (ON DELETE CASCADE) and with the account.',
  invite_code: 'Owner-created codes (created_by is the owner); not data about the user exporting. The user\'s own redemption is exported.',
};
