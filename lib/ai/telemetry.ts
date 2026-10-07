/**
 * Per-attempt model telemetry. Fire-and-forget: `recordAiCall` never throws, never awaits
 * anything the caller waits on, and drops the row when there is no database. No prompt text.
 *
 * Convention: every file that owns a prompt exports `PROMPT_VERSION = 'x.y'` and passes it
 * as `options.telemetry.promptVersion`; bump it when the wording changes, so a quality
 * shift can be tied to a prompt edit.
 */

export interface AiCallRow {
  draftRunId?: string | null;
  userId?: string | null;
  stage: string;
  provider: string;
  model: string;
  path: 'structured' | 'json' | 'text';
  promptVersion?: string | null;
  inTokens: number;
  outTokens: number;
  latencyMs: number;
  errorClass?: string | null;
  finishReason?: string | null;
}

type Sink = (row: AiCallRow & { id: string }) => Promise<void> | void;

const state = ((globalThis as Record<symbol, unknown>)[Symbol.for('resumer.telemetry')] ??= {
  sink: undefined,
}) as { sink: Sink | null | undefined };

/** Test seam. `null` disables telemetry, `undefined` restores the database sink. */
export function setTelemetrySink(s: Sink | null | undefined): void {
  state.sink = s;
}

async function dbSink(row: AiCallRow & { id: string }): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) return;
  const [{ db, isDatabaseConfigured }, { aiCall }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema-ai'),
  ]);
  if (!isDatabaseConfigured) return;
  await db.insert(aiCall).values({
    ...row,
    draftRunId: row.draftRunId ?? null,
    userId: row.userId ?? null,
    promptVersion: row.promptVersion ?? null,
    errorClass: row.errorClass ?? null,
    finishReason: row.finishReason ?? null,
  });
}

export function recordAiCall(row: AiCallRow): void {
  try {
    if (state.sink === null) return;
    const full = { ...row, id: globalThis.crypto.randomUUID() };
    Promise.resolve((state.sink ?? dbSink)(full)).catch(() => {});
  } catch {
    // Telemetry must never be the reason a call fails.
  }
}

/**
 * Retention: delete rows older than `days` (default 90), in batches of 500 under a time budget
 * (`deadline`, default 5s from now). `more` = stopped with work left; the next run continues.
 */
export async function pruneAiCalls(
  db: { execute: (q: never) => PromiseLike<unknown> },
  days = 90,
  opts: { deadline?: number; batch?: number } = {},
): Promise<{ deleted: number; more: boolean }> {
  const { sql } = await import('drizzle-orm');
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const batch = opts.batch ?? 500;
  const deadline = opts.deadline ?? Date.now() + 5_000;
  let deleted = 0;
  for (;;) {
    if (Date.now() >= deadline) return { deleted, more: true };
    const r = await db.execute(
      sql`with gone as (delete from ai_call where id in (
            select id from ai_call where created_at < ${cutoff}::timestamp limit ${batch}
          ) returning 1) select count(*)::int as n from gone` as never,
    );
    const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] } | null)?.rows ?? []);
    const n = Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
    deleted += n;
    if (n < batch) return { deleted, more: false };
  }
}
