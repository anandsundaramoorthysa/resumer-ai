/**
 * The sync's SQL guards against a REAL Postgres (lib/sync/guards.ts), which the unit tests
 * only cover through an in-memory model: the step claim and compare-and-set on `sync_job`,
 * and the flag / un-flag writes on `profile_record`.
 *
 * Requires DATABASE_URL with the app schema applied (db:push). NOT part of `npm test`. Run:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/verify-sync-db.mts
 *
 * Writes only rows it owns: users `zz-sync-verify-*` (their sync_job and profile_record
 * rows cascade) — removed before and after. Exports `scenarios(db)` so the same checks run
 * against any Drizzle Postgres client (it is meant to be proven on PGlite).
 */
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';

// require(), not import: see scripts/verify-radar-db.mts.
const req = createRequire(import.meta.url);
const { drizzleJobStore, flagMissingRows, guardedStep, unflagSeen } =
  req('../lib/sync/guards.ts') as typeof import('../lib/sync/guards');

type Db = typeof import('../lib/db').db;

const PREFIX = 'zz-sync-verify-';
const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []);

export async function scenarios(db: Db): Promise<{ passed: number; failed: string[] }> {
  let passed = 0;
  const failed: string[] = [];
  const ok = (cond: unknown, name: string) => {
    if (cond) passed++;
    else failed.push(name);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  };
  const q = async (s: ReturnType<typeof sql>) => rowsOf(await db.execute(s));
  const store = drizzleJobStore(db);

  const mkUser = async (n: string) => {
    const id = `${PREFIX}${n}`;
    await q(sql`insert into "user" (id) values (${id}) on conflict do nothing`);
    return id;
  };
  let seq = 0;
  const mkJob = async (userId: string, step = 1, status = 'running') => {
    const id = `${PREFIX}job-${Date.now()}-${++seq}`;
    await q(sql`insert into sync_job (id, user_id, status, step, total_steps, message)
      values (${id}, ${userId}, ${status}, ${step}, 5, 'start')`);
    return id;
  };
  const job = async (id: string) => (await q(sql`select * from sync_job where id = ${id}`))[0];
  const mkRecord = async (userId: string, name: string, over: { source?: string; state?: string; flagged?: boolean } = {}) => {
    const id = `${PREFIX}rec-${Date.now()}-${++seq}`;
    await q(sql`insert into profile_record (id, user_id, type, source, content_hash, tags, data, flagged_for_removal, review_state)
      values (${id}, ${userId}, 'skill', ${over.source ?? 'github-sync'}, ${id}, '[]'::jsonb,
        ${JSON.stringify({ name, category: 'tool' })}::jsonb, ${over.flagged ?? false}, ${over.state ?? 'approved'})`);
    return id;
  };
  const flagged = async (id: string) =>
    (await q(sql`select flagged_for_removal as f from profile_record where id = ${id}`))[0].f as boolean;
  const cleanup = async () => {
    await q(sql`delete from "user" where id like ${PREFIX + '%'}`);
  };
  const described = (e: unknown) => (e instanceof Error ? e.message : 'failed');

  await cleanup();
  try {
    /* (1) claim: one winner per step */
    const u1 = await mkUser('claim');
    const j1 = await mkJob(u1, 1);
    const now = Date.now();
    const claims = await Promise.all([store.claim(u1, j1, 1, now), store.claim(u1, j1, 1, now), store.claim(u1, j1, 1, now)]);
    ok(claims.filter(Boolean).length === 1, 'claim: three concurrent claims, exactly one wins');
    ok((await store.claim(u1, j1, 1, now + 1_000)) === false, 'claim: held lease blocks a later claim');
    ok(String((await job(j1)).error).startsWith('lease:'), 'claim: lease is recorded on the row');
    ok((await store.claim(u1, j1, 2, now)) === false, 'claim: wrong step refused');
    ok((await store.claim(`${PREFIX}other`, j1, 1, now)) === false, 'claim: wrong user refused');
    ok((await store.claim(u1, j1, 1, now + 120_000)) === true, 'claim: expired lease is reclaimable');
    await q(sql`update sync_job set error = 'lease:not-a-number-at-all' where id = ${j1}`);
    ok((await store.claim(u1, j1, 1, now + 130_000)) === true, 'claim: a malformed lease marker does not wedge the job (and does not throw)');
    await q(sql`update sync_job set error = null, status = 'done' where id = ${j1}`);
    ok((await store.claim(u1, j1, 1, now + 500_000)) === false, 'claim: finished job refused');

    /* (2) advance: compare-and-set on step */
    const u2 = await mkUser('cas');
    const j2 = await mkJob(u2, 1);
    ok((await store.advance(u2, j2, 3, { step: 4, message: 'hack' })) === false, 'advance: wrong step changes nothing');
    ok((await store.advance(`${PREFIX}other`, j2, 1, { step: 2, message: 'hack' })) === false, 'advance: wrong user changes nothing');
    ok((await job(j2)).message === 'start' && (await job(j2)).step === 1, 'advance: row untouched after refused writes');
    await store.claim(u2, j2, 1, now);
    const adv = await Promise.all([
      store.advance(u2, j2, 1, { step: 2, message: 'first', partials: [{ a: 1 }] }),
      store.advance(u2, j2, 1, { step: 2, message: 'second', partials: [{ b: 2 }] }),
    ]);
    ok(adv.filter(Boolean).length === 1, 'advance: two concurrent writes from the same step, exactly one lands');
    const after = await job(j2);
    ok(after.step === 2 && after.error === null, 'advance: step moved on and lease cleared');
    const msg = after.message as string;
    const parts = JSON.stringify(after.partials);
    ok((msg === 'first' && parts === '[{"a":1}]') || (msg === 'second' && parts === '[{"b":2}]'), 'advance: partials are the winner\'s, jsonb round-trips, never mixed');
    ok((await store.advance(u2, j2, 1, { step: 2, message: 'late' })) === false, 'advance: a late write from the old step is refused');
    await q(sql`update sync_job set status = 'error' where id = ${j2}`);
    ok((await store.advance(u2, j2, 2, { step: 3, message: 'revive' })) === false, 'advance: cannot revive a failed job');

    /* (3) guardedStep end to end: the work runs once, the loser sees the winner's state */
    const u3 = await mkUser('guard');
    const j3 = await mkJob(u3, 1);
    let runs = 0;
    const work = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 80));
      return {
        patch: { step: 2, message: 'read slice' },
        result: { step: 2, status: 'running' as const, message: 'read slice', done: false },
      };
    };
    const [r1, r2] = await Promise.all([
      guardedStep(store, u3, j3, work, described),
      guardedStep(store, u3, j3, work, described),
    ]);
    ok(runs === 1, 'guardedStep: two simultaneous requests run the step once');
    ok([r1, r2].filter((r) => r.stale).length === 1, 'guardedStep: the other is reported stale');
    ok((await job(j3)).step === 2, 'guardedStep: job advanced exactly one step');
    const failedRun = await guardedStep(store, u3, j3, async () => { throw new Error('boom'); }, described);
    ok(failedRun.status === 'error' && (await job(j3)).error === 'boom' && (await job(j3)).status === 'error', 'guardedStep: a failing step stores its message and status');

    /* (4) un-flag: only flagged github-sync rows of this user */
    const u4 = await mkUser('unflag');
    const other = await mkUser('unflag-other');
    const fSync = await mkRecord(u4, 'A', { flagged: true });
    const fManual = await mkRecord(u4, 'B', { source: 'manual', flagged: true });
    const fOther = await mkRecord(other, 'C', { flagged: true });
    const clean = await mkRecord(u4, 'D');
    const cleared = await unflagSeen(db, u4, [fSync, fManual, fOther, clean]);
    ok(cleared.length === 1 && cleared[0] === fSync, 'unflag: returns only the flagged github-sync row');
    ok(!(await flagged(fSync)), 'unflag: sync row is cleared');
    ok((await flagged(fManual)) === true, 'unflag: a manual row is never touched');
    ok((await flagged(fOther)) === true, "unflag: another user's row is never touched");
    ok((await unflagSeen(db, u4, [])).length === 0, 'unflag: empty list is a no-op');

    /* (5) flag-missing: only approved github-sync rows */
    const u5 = await mkUser('flag');
    const a = await mkRecord(u5, 'A');
    const p = await mkRecord(u5, 'P', { state: 'pending' });
    const rj = await mkRecord(u5, 'R', { state: 'rejected' });
    const m = await mkRecord(u5, 'M', { source: 'manual' });
    const set = await flagMissingRows(db, u5, [a, p, rj, m]);
    ok(set.length === 1 && set[0] === a, 'flag: only the approved github-sync row is flagged');
    ok(!(await flagged(p)) && !(await flagged(rj)) && !(await flagged(m)), 'flag: pending, rejected and manual rows are left alone');
    const back = await unflagSeen(db, u5, [a]);
    ok(back.length === 1 && !(await flagged(a)), 'flag then un-flag: the record is restored by being seen again');
  } finally {
    await cleanup();
  }
  return { passed, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config');
  if (!process.env.DATABASE_URL) {
    console.error('verify-sync-db needs DATABASE_URL (a Postgres with the app schema applied).');
    process.exit(2);
  }
  const { db } = await import('../lib/db');
  const res = await scenarios(db);
  console.log(`\n${res.passed} passed, ${res.failed.length} failed`);
  if (res.failed.length) console.log(res.failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(res.failed.length ? 1 : 0);
}
