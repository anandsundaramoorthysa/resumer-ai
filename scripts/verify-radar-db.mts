/**
 * Job Radar against a REAL Postgres: the Drizzle run store (lib/radar/runs.ts) and cache
 * store (lib/serp/budget.ts), which unit tests only cover through in-memory fakes.
 *
 * Requires DATABASE_URL, with scripts/2026-10-06-job-radar.sql (or db:push) already applied.
 * NOT part of `npm test`. Run:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/verify-radar-db.mts
 *
 * Writes only rows it owns: users `zz-radar-verify-*` (their agent_run rows cascade) and
 * serp_cache keys `zzverify:*` / `attempt:<fixed-now>:*`. The real 'account' memo row is
 * saved first and restored at the end. Exports `scenarios(db)` so the same checks can run
 * against any Drizzle Postgres client (it was first proven on PGlite).
 */
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { createRequire } from 'node:module';
import type { RadarDeps, RunInit } from '../lib/radar/runs';
import { emptyState } from '../lib/radar/events';

// require(), not import: tsx wraps CJS-typed .ts files loaded by import in a data: URL, and the
// stores' lazy import('drizzle-orm') cannot resolve bare specifiers from there.
const req = createRequire(import.meta.url);
const { drizzleRunStore, startRadar } = req('../lib/radar/runs.ts') as typeof import('../lib/radar/runs');
const { creditStatus, drizzleStore, hourUsed, noteAttempt, runAllowed, setSerpDeps, resetSerpDeps } =
  req('../lib/serp/budget.ts') as typeof import('../lib/serp/budget');

type Db = typeof import('../lib/db').db;

const PREFIX = 'zz-radar-verify-';
const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []);
const code = (e: unknown) => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.code ?? x?.cause?.code;
};

export async function scenarios(db: Db): Promise<{ passed: number; failed: string[] }> {
  let passed = 0;
  const failed: string[] = [];
  const ok = (cond: unknown, name: string) => {
    if (cond) passed++;
    else failed.push(name);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  };
  const q = async (s: ReturnType<typeof sql>) => rowsOf(await db.execute(s));

  const runs = drizzleRunStore(db);
  const cache = drizzleStore(db);
  const init = (over: Partial<RunInit> = {}): RunInit => ({
    status: 'running',
    phase: 'plan',
    step: 0,
    totalSteps: 5,
    message: 'x',
    state: emptyState(true),
    events: [],
    creditsUsed: 0,
    mode: 'live',
    error: '',
    ...over,
  });
  const cap = { since: new Date(Date.now() - 6 * 3_600_000), allowed: runAllowed };
  const mkUser = async (n: string) => {
    const id = `${PREFIX}${n}`;
    await q(sql`insert into "user" (id) values (${id}) on conflict do nothing`);
    return id;
  };
  let seq = 0;
  const seed = async (userId: string, status: string, credits: number) => {
    const id = `${PREFIX}row-${Date.now()}-${++seq}`;
    await q(sql`insert into agent_run (id, user_id, status, credits_used, created_at, updated_at)
      values (${id}, ${userId}, ${status}, ${credits}, now() at time zone 'utc', now() at time zone 'utc')`);
    return id;
  };
  const cleanup = async () => {
    await q(sql`delete from "user" where id like ${PREFIX + '%'}`);
    await q(sql`delete from serp_cache where key like 'zzverify:%'`);
  };

  const savedAccount = (await q(sql`select key, engine, payload, fetched_at from serp_cache where key = 'account'`))[0];
  const NOW = Date.now();
  await cleanup();
  try {
    // Seeded first: the eviction sweep runs once per process-hour, on the first insert().
    const oldTs = sql`(now() at time zone 'utc') - interval '3 days'`;
    await q(sql`insert into serp_cache (key, engine, payload, fetched_at) values ('zzverify:old', 'google_jobs', '{}'::jsonb, ${oldTs})`);
    await q(sql`insert into serp_cache (key, engine, payload, fetched_at) values ('account', 'account', '{"total_searches_left": 1}'::jsonb, ${oldTs})
      on conflict (key) do update set fetched_at = excluded.fetched_at, payload = excluded.payload`);
    /* (1) claim: one winner, lease expiry */
    const u1 = await mkUser('claim');
    const r1 = (await runs.insert(u1, init(), cap))!;
    const claims = await Promise.all([runs.claim(u1, r1.id, 0), runs.claim(u1, r1.id, 0)]);
    ok(claims.filter(Boolean).length === 1, 'claim: two concurrent claims, exactly one wins');
    ok((await runs.claim(u1, r1.id, 0)) === null, 'claim: held lease blocks a third claim');
    const won = claims.find(Boolean)!;
    ok(won.leasedUntil instanceof Date && won.leasedUntil.getTime() > Date.now() + 30_000, 'claim: lease about 45s ahead');
    ok((await runs.claim(u1, r1.id, 1)) === null, 'claim: wrong step refused');
    ok((await runs.claim(`${PREFIX}other`, r1.id, 0)) === null, 'claim: wrong user refused');
    await q(sql`update agent_run set leased_until = now() - interval '1 second' where id = ${r1.id}`);
    ok((await runs.claim(u1, r1.id, 0)) !== null, 'claim: expired lease is reclaimable');
    await q(sql`update agent_run set status = 'awaiting', leased_until = null where id = ${r1.id}`);
    ok((await runs.claim(u1, r1.id, 0)) === null, 'claim: non-running run refused');

    /* (4) update compare-and-set */
    const u4 = await mkUser('cas');
    const r4 = (await runs.insert(u4, init(), cap))!;
    ok((await runs.update(r4.id, { userId: `${PREFIX}other`, step: 0 }, { message: 'hack' })) === null, 'update: wrong user changes nothing');
    ok((await runs.update(r4.id, { userId: u4, step: 9 }, { message: 'hack' })) === null, 'update: wrong step changes nothing');
    ok((await runs.update(r4.id, { userId: u4, step: 0, status: ['awaiting'] }, { message: 'hack' })) === null, 'update: wrong status changes nothing');
    ok((await runs.get(u4, r4.id))?.message === 'x', 'update: row untouched after refused updates');
    const st = { ...emptyState(true), okQueries: 2 };
    const upd = await runs.update(r4.id, { userId: u4, step: 0, status: ['running'] }, { message: 'ok', step: 1, state: st, leasedUntil: null, creditsUsed: 3 });
    ok(upd?.message === 'ok' && upd.step === 1 && upd.creditsUsed === 3 && upd.state.okQueries === 2, 'update: right user/step/status applies and round-trips jsonb');

    /* (2) concurrent insert x6 */
    const u2 = await mkUser('conc');
    const six = await Promise.all(Array.from({ length: 6 }, () => runs.insert(u2, init(), cap).then((r) => ({ r }), (e) => ({ e }))));
    ok(six.every((x) => 'r' in x && x.r), 'insert x6: none threw or returned null');
    const ids = new Set(six.map((x) => ('r' in x ? x.r?.id : undefined)));
    ok(ids.size === 1, 'insert x6: all callers got the same run');
    ok(Number((await q(sql`select count(*)::int as n from agent_run where user_id = ${u2}`))[0].n) === 1, 'insert x6: exactly one row exists');

    /* (3) daily cap */
    const u3 = await mkUser('cap');
    await seed(u3, 'done', 0);
    await seed(u3, 'error', 2);
    await seed(u3, 'cancelled', 0); // not counted
    await seed(u3, 'error', 0); // not counted
    const third = await Promise.all([1, 2, 3].map(() => runs.insert(u3, init(), cap)));
    ok(third.every((r) => r && r.id === third[0]!.id), 'cap: 2 counted + concurrent starts => one new run for all');
    ok(Number((await q(sql`select count(*)::int as n from agent_run where user_id = ${u3} and status = 'running'`))[0].n) === 1, 'cap: one running row');
    await q(sql`update agent_run set status = 'done' where id = ${third[0]!.id}`);
    ok((await runs.insert(u3, init(), cap)) === null, 'cap: 3 counted (done, error>0, done) => refused');
    ok((await runs.insert(u3, init(), { since: new Date(Date.now() + 60_000), allowed: runAllowed })) !== null, 'cap: rows before `since` are not counted');

    /* (7) partial unique index */
    const u7 = await mkUser('idx');
    const a = await seed(u7, 'running', 0);
    let c7: string | undefined;
    try { await seed(u7, 'awaiting', 0); } catch (e) { c7 = code(e); }
    ok(c7 === '23505', 'index: second active row (awaiting) rejected with 23505');
    await q(sql`update agent_run set status = 'done' where id = ${a}`);
    ok((await seed(u7, 'running', 0)).length > 0, 'index: new active row allowed after done');
    await q(sql`update agent_run set status = 'cancelled' where user_id = ${u7} and status = 'running'`);
    ok((await seed(u7, 'awaiting', 0)).length > 0, 'index: new active row allowed after cancelled');
    ok((await seed(u7, 'error', 0)).length > 0 && (await seed(u7, 'done', 0)).length > 0, 'index: any number of terminal rows');

    /* (5) stale run auto-cancelled; latestActive */
    const u5 = await mkUser('stale');
    const stale = (await runs.insert(u5, init(), cap))!;
    ok((await runs.latestActive(u5))?.id === stale.id, 'latestActive: finds the active run');
    await q(sql`update agent_run set updated_at = (now() at time zone 'utc') - interval '2 hours' where id = ${stale.id}`);
    const deps = { store: runs, now: () => Date.now() } as unknown as RadarDeps;
    const fresh = await startRadar(u5, {}, deps);
    ok(fresh.runId !== stale.id && fresh.status === 'running', 'stale: >60min run replaced by a new one');
    const old = await runs.get(u5, stale.id);
    ok(old?.status === 'cancelled' && old.leasedUntil === null, 'stale: old run cancelled');
    ok(Number((await q(sql`select count(*)::int as n from agent_run where user_id = ${u5} and status in ('running','awaiting')`))[0].n) === 1, 'stale: one active run');
    const again = await startRadar(u5, {}, deps);
    ok(again.runId === fresh.runId, 'startRadar: fresh active run is returned, not duplicated');

    /* (6) serp cache */
    await cache.put('zzverify:k', 'google_jobs', { a: [1, 2] });
    const g1 = await cache.get('zzverify:k');
    ok(JSON.stringify(g1?.payload) === '{"a":[1,2]}' && Math.abs(Date.now() - g1!.fetchedAt.getTime()) < 60_000, 'cache: put/get round-trips payload, fetchedAt is now (UTC)');
    await q(sql`update serp_cache set fetched_at = ${oldTs} where key = 'zzverify:k'`);
    ok(Date.now() - (await cache.get('zzverify:k'))!.fetchedAt.getTime() > 2.9 * 86_400_000, 'cache: stored age is readable (TTL decided by caller)');
    await cache.put('zzverify:k', 'google_jobs', { a: 2 });
    const g2 = await cache.get('zzverify:k');
    ok((g2?.payload as { a: number }).a === 2 && Date.now() - g2!.fetchedAt.getTime() < 60_000, 'cache: put upserts and refreshes fetchedAt');
    ok((await cache.get('zzverify:missing')) === null, 'cache: miss is null');

    const base = await cache.countSince(new Date(Date.now() - 3_600_000));
    await q(sql`insert into serp_cache (key, engine, payload, fetched_at) values
      ('zzverify:att1', 'attempt', '{}'::jsonb, now() at time zone 'utc'),
      ('zzverify:att2', 'attempt', '{}'::jsonb, (now() at time zone 'utc') - interval '30 minutes'),
      ('zzverify:att3', 'attempt', '{}'::jsonb, (now() at time zone 'utc') - interval '150 minutes'),
      ('zzverify:notattempt', 'google_jobs', '{}'::jsonb, now() at time zone 'utc')`);
    ok((await cache.countSince(new Date(Date.now() - 3_600_000))) === base + 2, 'countSince: counts only attempt rows inside the hour');
    await new Promise((r) => setTimeout(r, 300));
    ok(Number((await q(sql`select count(*)::int as n from serp_cache where key = 'zzverify:att3'`))[0].n) === 0, 'countSince: stale attempt row cleaned up');
    ok(Number((await q(sql`select count(*)::int as n from serp_cache where key = 'zzverify:att2'`))[0].n) === 1, 'countSince: in-window attempt row kept');

    setSerpDeps({ store: cache, now: () => NOW, env: () => ({ SERPAPI_API_KEY: 'k' }) });
    const before = await hourUsed();
    await noteAttempt();
    await noteAttempt();
    ok((await cache.countSince(new Date(NOW - 3_600_000))) >= 2 && (await hourUsed()) >= before + 2, 'noteAttempt: writes attempt rows, hourUsed sees them');
    let fetches = 0;
    const fakeFetch = (async () => {
      fetches++;
      return new Response(JSON.stringify({ total_searches_left: 123 }), { status: 200 });
    }) as unknown as typeof fetch;
    setSerpDeps({ store: cache, fetch: fakeFetch, now: () => Date.now(), env: () => ({ SERPAPI_API_KEY: 'k' }) });
    const cs1 = await creditStatus();
    ok(cs1.left === 123 && fetches === 1, 'account: stale memo row => fetches account.json');
    const acct = (await q(sql`select engine, payload from serp_cache where key = 'account'`))[0];
    ok(acct?.engine === 'account' && (acct.payload as { total_searches_left: number }).total_searches_left === 123, 'account: memo row written');
    setSerpDeps({ store: cache, fetch: fakeFetch, now: () => Date.now(), env: () => ({ SERPAPI_API_KEY: 'k' }) }); // clears the in-process memo
    const cs2 = await creditStatus();
    ok(cs2.left === 123 && fetches === 1, 'account: fresh memo row is read from the DB, no second fetch');

    const u6 = await mkUser('evict');
    await runs.insert(u6, init(), cap);
    await new Promise((r) => setTimeout(r, 400));
    ok(Number((await q(sql`select count(*)::int as n from serp_cache where key = 'zzverify:old'`))[0].n) === 0, 'evict: >24h cache row deleted');
    ok(Number((await q(sql`select count(*)::int as n from serp_cache where key = 'account'`))[0].n) === 1, "evict: 'account' memo row survives");
  } finally {
    resetSerpDeps();
    await q(sql`delete from serp_cache where key like ${'attempt:' + NOW + ':%'}`);
    await cleanup();
    await q(sql`delete from serp_cache where key = 'account'`);
    if (savedAccount) {
      await q(sql`insert into serp_cache (key, engine, payload, fetched_at)
        values ('account', ${savedAccount.engine as string}, ${JSON.stringify(savedAccount.payload)}::jsonb, ${savedAccount.fetched_at as string}::timestamp)`);
    }
  }
  return { passed, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config');
  if (!process.env.DATABASE_URL) {
    console.error('verify-radar-db needs DATABASE_URL (a Postgres with scripts/2026-10-06-job-radar.sql applied).');
    process.exit(2);
  }
  const { db } = await import('../lib/db');
  const res = await scenarios(db);
  console.log(`\n${res.passed} passed, ${res.failed.length} failed`);
  if (res.failed.length) console.log(res.failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(res.failed.length ? 1 : 0);
}
