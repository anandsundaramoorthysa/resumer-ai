/**
 * Retention: deleting what is finished with.
 *
 * Two entry points, one function. `scope: 'hourly'` (called by /api/cron/alerts) is the
 * original cheap pass: expired auth rows and old sync jobs. `scope: 'daily'` (the default,
 * /api/cron/housekeeping at 03:30 UTC) adds the full retention table:
 *
 *   draft_run            90 days            audit_log           12 months
 *   agent_run + cache    lib/radar/housekeeping.ts (30 days / 24h)
 *   denied accounts      30 days after the decision (owners never)
 *   audit_log.diff.prompt  nulled after 90 days (prompt text is the most sensitive column)
 *   ai_call              90 days (lib/ai/telemetry.ts)
 *   inactive accounts    24 months: REPORT ONLY (dry run). Nothing is deleted; the owner
 *                        emails a notice first - see docs/production/OPERATIONS.md.
 *
 * Every delete runs in batches of 500 (`delete ... where id in (select id ... limit 500)`)
 * so no statement holds locks long, loops share one time budget (8s default - a Netlify
 * function ceiling is 10s), and the whole thing is idempotent: a run cut short reports
 * `more: true` and tomorrow's run carries on. Nothing here can be read by the app.
 */

import 'server-only';
import { and, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { syncJobs, users } from '@/lib/db/schema';
import { purgeOldAttempts } from '@/lib/auth/rate-limit';
import { purgeExpiredTokens } from '@/lib/auth/tokens';
import { ownerEmails } from '@/lib/ai/daily-budget';

export const SYNC_JOB_KEPT_DAYS = 7;
export const RETENTION = {
  draftRunDays: 90,
  auditLogMonths: 12,
  auditPromptDays: 90,
  deniedAccountDays: 30,
  inactiveAccountMonths: 24,
  aiCallDays: 90,
} as const;

export const DEFAULT_BUDGET_MS = 8_000;
export const BATCH = 500;

const DAY = 86_400_000;

/** All cutoffs as ISO strings, a pure function of `now` (tested). */
export function cutoffs(now: Date) {
  const days = (n: number) => new Date(now.getTime() - n * DAY).toISOString();
  const months = (n: number) => {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString();
  };
  return {
    syncJob: days(SYNC_JOB_KEPT_DAYS),
    draftRun: days(RETENTION.draftRunDays),
    auditLog: months(RETENTION.auditLogMonths),
    auditPrompt: days(RETENTION.auditPromptDays),
    deniedAccount: days(RETENTION.deniedAccountDays),
    inactiveAccount: months(RETENTION.inactiveAccountMonths),
  };
}

/**
 * Repeats `step` (which does one batch and returns how many rows it touched) until a short
 * batch, the batch cap, or the deadline. `more` means it stopped with work possibly left.
 */
export async function batched(
  step: (limit: number) => Promise<number>,
  opts: { deadline: number; batch?: number; maxBatches?: number; now?: () => number },
): Promise<{ n: number; more: boolean }> {
  const batch = opts.batch ?? BATCH;
  const max = opts.maxBatches ?? 200;
  const now = opts.now ?? Date.now;
  let n = 0;
  for (let i = 0; i < max; i++) {
    if (now() >= opts.deadline) return { n, more: true };
    const got = await step(batch);
    n += got;
    if (got < batch) return { n, more: false };
  }
  return { n, more: true };
}

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  Array.isArray(r) ? r : ((r as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? []);
const countOf = (r: unknown): number => Number(rowsOf(r)[0]?.n ?? 0);

/** table is always a constant from this file, never input. */
const deleteBatch = (table: string, where: SQL) => (limit: number) =>
  db
    .execute(
      sql`with gone as (delete from ${sql.raw(`"${table}"`)} where id in (
            select id from ${sql.raw(`"${table}"`)} where ${where} limit ${limit}
          ) returning 1) select count(*)::int as n from gone`,
    )
    .then(countOf);

const nullPromptBatch = (cutoff: string) => (limit: number) =>
  db
    .execute(
      sql`with t as (update audit_log set diff = jsonb_set(diff, '{prompt}', 'null'::jsonb) where id in (
            select id from audit_log
            where created_at < ${cutoff}::timestamp
              and diff is not null and jsonb_exists(diff, 'prompt')
              and jsonb_typeof(diff -> 'prompt') <> 'null'
            limit ${limit}
          ) returning 1) select count(*)::int as n from t`,
    )
    .then(countOf);

export const STALE_DRAFT_RUN_MS = 15 * 60 * 1000;

/**
 * Closes draft_run rows left `running` by a killed process (SIGKILL, OOM, platform timeout:
 * the stream's `finish` never ran). A row older than `olderThanMs` that already saved its
 * snapshot is closed as `success` (the resume exists; only the bookkeeping died); the rest
 * become `failed` / `timeout`. Batched and idempotent: a second pass finds nothing.
 */
export async function reapStaleDraftRuns(
  database: { execute: (q: SQL) => Promise<unknown> },
  opts: { olderThanMs?: number; now?: Date; batch?: number; deadline?: number } = {},
): Promise<{ failed: number; succeeded: number; more: boolean }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.olderThanMs ?? STALE_DRAFT_RUN_MS)).toISOString();
  const stamp = now.toISOString();
  const deadline = opts.deadline ?? Date.now() + DEFAULT_BUDGET_MS;

  const close = (saved: boolean) => (limit: number) =>
    database
      .execute(
        saved
          ? sql`with t as (update draft_run set status = 'success', finished_at = ${stamp}::timestamp
                  where id in (select id from draft_run where status = 'running'
                    and started_at < ${cutoff}::timestamp and snapshot_id is not null limit ${limit})
                  returning 1) select count(*)::int as n from t`
          : sql`with t as (update draft_run set status = 'failed', error_kind = 'timeout',
                    error_detail = coalesce(error_detail, 'Reaped: still running after the stale-run cutoff; the process was killed or timed out.'),
                    finished_at = ${stamp}::timestamp
                  where id in (select id from draft_run where status = 'running'
                    and started_at < ${cutoff}::timestamp and snapshot_id is null limit ${limit})
                  returning 1) select count(*)::int as n from t`,
      )
      .then(countOf);

  const ok = await batched(close(true), { deadline, batch: opts.batch });
  const bad = await batched(close(false), { deadline, batch: opts.batch });
  return { failed: bad.n, succeeded: ok.n, more: ok.more || bad.more };
}

/** Accounts with no sign of life for 24 months. Selection only: nothing is deleted. */
export async function selectInactiveAccounts(
  now = new Date(),
  limit = 200,
): Promise<{ count: number; sampleIds: string[] }> {
  const cutoff = cutoffs(now).inactiveAccount;
  const owners = [...ownerEmails()];
  const res = await db.execute(sql`
    select u.id, lower(coalesce(u.email, '')) as email from "user" u
    where u.approval <> 'denied' and u.created_at < ${cutoff}::timestamp
      and (u.last_synced_at is null or u.last_synced_at < ${cutoff}::timestamp)
      and not exists (select 1 from draft_run d where d.user_id = u.id and d.started_at >= ${cutoff}::timestamp)
      and not exists (select 1 from resume_snapshot s where s.user_id = u.id and s.created_at >= ${cutoff}::timestamp)
      and not exists (select 1 from audit_log l where l.user_id = u.id and l.created_at >= ${cutoff}::timestamp)
      and not exists (select 1 from agent_run a where a.user_id = u.id and a.created_at >= ${cutoff}::timestamp)
    order by u.created_at limit ${limit}`);
  const ids = rowsOf(res)
    .filter((r) => !owners.includes(String(r.email)))
    .map((r) => String(r.id));
  return { count: ids.length, sampleIds: ids.slice(0, 20) };
}

export interface HousekeepingOutcome {
  syncJobsDeleted: number;
  corpusCleared: number;
  draftRunsDeleted: number;
  /** Unfinished draft runs closed by the reaper (both outcomes). */
  draftRunsReaped: { failed: number; succeeded: number };
  auditRowsDeleted: number;
  auditPromptsNulled: number;
  deniedAccountsDeleted: number;
  aiCallsPruned: boolean;
  radar: unknown;
  /** Dry run only - see header. */
  inactiveAccounts: { count: number; sampleIds: string[] } | null;
  /** A time budget or batch cap was hit; the next run continues. */
  more: boolean;
  tookMs: number;
  errors: string[];
}

export async function runHousekeeping(
  now = new Date(),
  opts: { scope?: 'hourly' | 'daily'; budgetMs?: number } = {},
): Promise<HousekeepingOutcome> {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const daily = (opts.scope ?? 'daily') === 'daily';
  const c = cutoffs(now);
  const out: HousekeepingOutcome = {
    syncJobsDeleted: 0,
    corpusCleared: 0,
    draftRunsDeleted: 0,
    draftRunsReaped: { failed: 0, succeeded: 0 },
    auditRowsDeleted: 0,
    auditPromptsNulled: 0,
    deniedAccountsDeleted: 0,
    aiCallsPruned: false,
    radar: null,
    inactiveAccounts: null,
    more: false,
    tookMs: 0,
    errors: [],
  };
  const guard = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      // One failed purge must not stop the others, or the alert that runs beside them.
      out.errors.push(`${what}: ${err instanceof Error ? err.message.slice(0, 120) : 'failed'}`);
    }
  };
  const run = async (what: string, step: (limit: number) => Promise<number>, into: (n: number) => void, batch = BATCH) =>
    guard(what, async () => {
      const r = await batched(step, { deadline, batch });
      into(r.n);
      if (r.more) out.more = true;
    });

  await guard('auth attempts', purgeOldAttempts);
  await guard('expired tokens', purgeExpiredTokens);
  await run(
    'old sync jobs',
    deleteBatch('sync_job', sql`status <> 'running' AND updated_at < ${c.syncJob}::timestamp`),
    (n) => (out.syncJobsDeleted = n),
  );
  await guard('failed job corpus', async () => {
    const cleared = await db
      .update(syncJobs)
      .set({ corpus: sql`null`, partials: [] })
      .where(and(eq(syncJobs.status, 'error'), sql`${syncJobs.corpus} is not null`))
      .returning({ id: syncJobs.id });
    out.corpusCleared = cleared.length;
  });

  // Every pass (hourly too): a killed draft should not look "running" for a day.
  await guard('stale draft runs', async () => {
    const r = await reapStaleDraftRuns(db, { now, deadline });
    out.draftRunsReaped = { failed: r.failed, succeeded: r.succeeded };
    if (r.more) out.more = true;
  });

  if (daily) {
    await run('draft runs', deleteBatch('draft_run', sql`started_at < ${c.draftRun}::timestamp`), (n) => (out.draftRunsDeleted = n));
    await run('audit prompts', nullPromptBatch(c.auditPrompt), (n) => (out.auditPromptsNulled = n));
    await run('audit log', deleteBatch('audit_log', sql`created_at < ${c.auditLog}::timestamp`), (n) => (out.auditRowsDeleted = n));

    await run(
      'denied accounts',
      async (limit) => {
        const owners = ownerEmails();
        const candidates = await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(and(eq(users.approval, 'denied'), lt(users.approvalDecidedAt, new Date(c.deniedAccount))))
          .limit(limit); // cascades are heavy, so this step runs with batch = 50
        const ids = candidates.filter((u) => !owners.has((u.email ?? '').toLowerCase())).map((u) => u.id);
        if (ids.length) await db.delete(users).where(inArray(users.id, ids));
        return ids.length;
      },
      (n) => (out.deniedAccountsDeleted = n),
      50,
    );

    await guard('radar data', async () => {
      const mod = await import('@/lib/radar/housekeeping').catch(() => null);
      if (!mod?.pruneRadarData) return;
      out.radar = await mod.pruneRadarData(db, { deadline });
      if ((out.radar as { more?: boolean }).more) out.more = true;
    });
    await guard('ai calls', async () => {
      const mod = await import('@/lib/ai/telemetry').catch(() => null);
      if (!mod?.pruneAiCalls) return;
      const r = await mod.pruneAiCalls(db as never, RETENTION.aiCallDays, { deadline });
      out.aiCallsPruned = !r.more;
      if (r.more) out.more = true;
    });
    await guard('inactive accounts (report only)', async () => {
      out.inactiveAccounts = await selectInactiveAccounts(now);
    });
  }

  out.tookMs = Date.now() - started;
  return out;
}

/* ------------------------------------------------------------------ heartbeats & ops alerts ---- */

/** Stamp "this scheduled job just ran" into app_setting (key `hb:<name>`). Never throws. */
export async function recordHeartbeat(name: string): Promise<void> {
  try {
    await db.execute(
      sql`insert into app_setting (key, value, updated_at) values (${`hb:${name}`}, 'ok', now())
          on conflict (key) do update set value = 'ok', updated_at = now()`,
    );
  } catch {
    /* the table may not be migrated yet; a missing heartbeat must not fail the job */
  }
}

/** Last recorded run per job, ISO timestamps. */
export async function lastHeartbeats(): Promise<Record<string, string>> {
  try {
    const rows = rowsOf(await db.execute(sql`select key, updated_at from app_setting where key like 'hb:%'`));
    return Object.fromEntries(rows.map((r) => [String(r.key).slice(3), new Date(r.updated_at as string).toISOString()]));
  } catch {
    return {};
  }
}

/**
 * True for the first caller in each window, false after: an atomic upsert on app_setting,
 * so concurrent doorbells cannot both send the same alert. Fails OPEN (true) when the
 * table is unreachable - a duplicate email is better than a silent outage.
 */
export async function claimAlert(kind: string, windowMs = DAY): Promise<boolean> {
  try {
    const rows = rowsOf(
      await db.execute(
        sql`insert into app_setting (key, value, updated_at) values (${`alert:${kind}`}, 'sent', now())
            on conflict (key) do update set updated_at = now()
              where app_setting.updated_at < now() - ${`${Math.floor(windowMs / 1000)} seconds`}::interval
            returning key`,
      ),
    );
    return rows.length > 0;
  } catch {
    return true;
  }
}

export interface OpsFinding {
  kind: 'credits-low' | 'stuck-runs' | 'db-error';
  detail: string;
}

export const LOW_CREDITS_AT = Number(process.env.SERP_LOW_CREDITS ?? 25);
export const STUCK_RUN_MINUTES = 30;

/** Credits low, radar runs stuck, database unreachable. Each check is independently guarded. */
export async function collectOpsFindings(): Promise<OpsFinding[]> {
  const found: OpsFinding[] = [];
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    return [{ kind: 'db-error', detail: err instanceof Error ? err.message.slice(0, 120) : 'query failed' }];
  }
  try {
    const mod = await import('@/lib/serp/client').catch(() => null);
    const s = mod?.creditStatus ? await mod.creditStatus() : null;
    if (s && s.left >= 0 && s.left < LOW_CREDITS_AT) {
      found.push({ kind: 'credits-low', detail: `${s.left} SerpApi searches left (alert below ${LOW_CREDITS_AT}); radar falls back to replay at zero.` });
    }
  } catch {
    /* credits are optional */
  }
  try {
    const n = countOf(
      await db.execute(
        sql`select count(*)::int as n from agent_run
            where status in ('running', 'awaiting')
              and updated_at < now() - ${`${STUCK_RUN_MINUTES} minutes`}::interval`,
      ),
    );
    if (n > 0) found.push({ kind: 'stuck-runs', detail: `${n} radar run(s) have not moved for over ${STUCK_RUN_MINUTES} minutes.` });
  } catch {
    /* radar tables may not exist */
  }
  return found;
}

export function composeOpsAlert(findings: OpsFinding[]): { subject: string; text: string } | null {
  if (findings.length === 0) return null;
  return {
    subject: `Resumer AI: ${findings.map((f) => f.kind).join(', ')}`,
    text: [...findings.map((f) => `- ${f.kind}: ${f.detail}`), '', 'See RUNBOOK.md, "Incident checklist".'].join('\n'),
  };
}
