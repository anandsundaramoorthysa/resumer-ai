/**
 * Audit entries for the one-off dedupe scripts.
 *
 * The dedupe scripts delete and rewrite `profile_record` rows with raw SQL, outside the
 * Drizzle path that `lib/server/profile.ts` `audit()` uses — so a row could vanish with
 * nothing recorded anywhere. That is not hypothetical: an engineer reviewing this project
 * spent real time tracing a profile that had gone from 172 records to 171, checking
 * `audit_log` for the window, finding nothing, and reasonably concluding another session
 * had written to the database concurrently. The row had simply been merged away by a
 * cleanup that left no trace.
 *
 * `audit_log.user_id` cascades on user delete and every column is plain, so writing to it
 * directly is safe from a script. The shape matches what `audit()` produces, so these
 * entries read the same as any other in the table.
 */
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';

/** The actions a dedupe pass can take, named the way `audit()` names them. */
export type DedupeAction = 'delete' | 'update';

export interface DedupeAuditEntry {
  userId: string;
  recordId: string | null;
  action: DedupeAction;
  /**
   * What changed, in enough detail to answer "where did this row go?" months later.
   * A merge names the row that survived; a delete names the row that absorbed it.
   */
  diff: Record<string, unknown>;
}

/**
 * Writes one audit row per entry, inside whatever transaction the caller is using.
 *
 * Taking the `sql` handle rather than opening its own means the audit lands or rolls back
 * with the change it describes. An audit written outside the transaction can survive a
 * rollback and describe something that never happened, which is worse than no audit.
 */
export async function recordDedupeAudit(
  sql: Sql,
  source: string,
  entries: DedupeAuditEntry[],
): Promise<void> {
  for (const entry of entries) {
    await sql`
      insert into audit_log (id, user_id, record_id, action, source, diff, created_at)
      values (
        ${randomUUID()},
        ${entry.userId},
        ${entry.recordId},
        ${entry.action},
        ${source},
        ${sql.json(entry.diff as never)},
        now()
      )`;
  }
}
