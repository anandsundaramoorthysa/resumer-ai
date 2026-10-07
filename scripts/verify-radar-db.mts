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

/** `prune: true` also runs the retention scenario, which deletes EVERY old cache/run row: scratch databases only. */
export async function scenarios(db: Db, opts: { prune?: boolean } = {}): Promise<{ passed: number; failed: string[] }> {
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
    const before = (await hourUsed()) ?? 0;
    await noteAttempt();
    await noteAttempt();
    ok((await cache.countSince(new Date(NOW - 3_600_000))) >= 2 && ((await hourUsed()) ?? 0) >= before + 2, 'noteAttempt: writes attempt rows, hourUsed sees them');
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

    /* (8) claim counts attempts in SQL */
    const u8 = await mkUser('attempts');
    const r8 = (await runs.insert(u8, init(), cap))!;
    ok(r8.attempts === 0, 'attempts: a new run starts at 0');
    const c8 = await runs.claim(u8, r8.id, 0);
    ok(c8?.attempts === 1, 'attempts: claim increments in SQL');
    await q(sql`update agent_run set leased_until = now() - interval '1 second' where id = ${r8.id}`);
    ok((await runs.claim(u8, r8.id, 0))?.attempts === 2, 'attempts: every reclaim increments');
    ok((await runs.claim(u8, r8.id, 0)) === null && Number((await q(sql`select attempts from agent_run where id = ${r8.id}`))[0].attempts) === 2, 'attempts: a refused claim does not increment');
    ok((await runs.update(r8.id, { userId: u8, step: 0, status: ['running'] }, { step: 1, leasedUntil: null, attempts: 0 }))?.attempts === 0, 'attempts: the commit resets it');
    const lease = (await q(sql`select extract(epoch from (leased_until - now()))::float as s from agent_run where id = ${r8.id}`))[0];
    ok(lease.s === null, 'attempts: commit cleared the lease');

    /* (9) credit reservation + ledger: idempotent by (run, key), capped, atomic */
    const u9 = await mkUser('reserve');
    const r9 = (await runs.insert(u9, init(), cap))!;
    const six9 = await Promise.all(Array.from({ length: 6 }, () => runs.reserve(u9, r9.id, 'q0', { engine: 'google_jobs', q: 'a', credits: 1 }, 12)));
    ok(six9.filter((x) => x === 'new').length === 1 && six9.filter((x) => x === 'exists').length === 5, 'reserve x6 same key: one new, five exists');
    ok((await runs.get(u9, r9.id))?.creditsUsed === 1, 'reserve x6: credits_used incremented once, in SQL');
    ok((await runs.reserve(u9, r9.id, 'q1', { engine: 'google_jobs', q: 'b', credits: 1 }, 12)) === 'new', 'reserve: a second key reserves');
    await runs.setSearchId(r9.id, 'q0', 'sid-1');
    await runs.setSearchId(r9.id, 'q0', 'sid-OVERWRITE');
    const led = await runs.getLedger(u9, r9.id);
    ok(led.length === 2 && led.find((x) => x.key === 'q0')?.searchId === 'sid-1' && led.find((x) => x.key === 'q1')?.searchId === '', 'ledger: id stored once, never overwritten; unstored id reads as empty');
    ok(led.every((x) => typeof x.submittedAt === 'number' && x.submittedAt > Date.now() - 60_000), 'ledger: submittedAt is epoch ms');
    ok((await runs.getLedger(`${PREFIX}other`, r9.id)).length === 0, 'ledger: scoped to the owner');
    await q(sql`update agent_run set credits_used = 11 where id = ${r9.id}`);
    const race = await Promise.all(['q2', 'i0'].map((k) => runs.reserve(u9, r9.id, k, { engine: 'x', q: 'c', credits: 1 }, 12)));
    ok(race.filter((x) => x === 'new').length === 1 && race.filter((x) => x === 'capped').length === 1, 'reserve: at 11/12 two concurrent reserves => exactly one wins');
    ok((await runs.get(u9, r9.id))?.creditsUsed === 12, 'reserve: never above the cap');
    ok(Number((await q(sql`select count(*)::int as n from radar_search where run_id = ${r9.id}`))[0].n) === 3, 'reserve: a capped reserve leaves no ledger row (rolled back)');
    ok((await runs.reserve(u9, r9.id, 'i1', { engine: 'intel', q: 'c', credits: 3 }, 12)) === 'capped', 'reserve: 3 more credits refused at 12/12');
    await runs.addCredits(u9, r9.id, -2);
    ok((await runs.get(u9, r9.id))?.creditsUsed === 10, 'addCredits: refund applies in SQL');
    await runs.addCredits(u9, r9.id, -99);
    ok((await runs.get(u9, r9.id))?.creditsUsed === 0, 'addCredits: never below zero');
    ok((await runs.reserve(`${PREFIX}other`, r9.id, 'zz', { engine: 'x', q: '', credits: 1 }, 12).catch(() => 'threw')) !== 'new', 'reserve: another user cannot reserve on this run');
    await q(sql`delete from agent_run where id = ${r9.id}`);
    ok(Number((await q(sql`select count(*)::int as n from radar_search where run_id = ${r9.id}`))[0].n) === 0, 'ledger: rows go with their run (cascade)');

    /* (10) single-flight inflight rows */
    const fk = 'zzverify:inflight:1';
    const claimsF = await Promise.all(Array.from({ length: 6 }, () => cache.claimInflight(fk)));
    ok(claimsF.filter(Boolean).length === 1, 'inflight x6: exactly one caller owns the key');
    ok((await cache.claimInflight(fk)) === false, 'inflight: a held key is refused');
    await q(sql`update serp_cache set fetched_at = (now() at time zone 'utc') - interval '25 seconds' where key = ${fk}`);
    ok((await cache.claimInflight(fk)) === true, 'inflight: a row older than 20s with no search id is taken over');
    await cache.put(fk, 'inflight', { searchId: 'sid-9' });
    await q(sql`update serp_cache set fetched_at = (now() at time zone 'utc') - interval '25 seconds' where key = ${fk}`);
    ok((await cache.claimInflight(fk)) === false, 'inflight: with a stored search id it stays owned (minutes)');
    await q(sql`update serp_cache set fetched_at = (now() at time zone 'utc') - interval '6 minutes' where key = ${fk}`);
    ok((await cache.claimInflight(fk)) === true, 'inflight: ... until it is 5 minutes old');
    await cache.put('zzverify:real-cache', 'google_jobs', { a: 1 });
    ok((await cache.claimInflight('zzverify:real-cache')) === false, 'inflight: never steals a real cache row');
    ok((await cache.get('zzverify:real-cache'))?.payload !== undefined && Number((await q(sql`select count(*)::int as n from serp_cache where key = 'zzverify:real-cache' and engine = 'google_jobs'`))[0].n) === 1, 'inflight: the cache row is untouched');
    await cache.releaseInflight('zzverify:real-cache');
    ok((await cache.get('zzverify:real-cache')) !== null, 'release: only deletes inflight rows');
    await cache.releaseInflight(fk);
    ok((await cache.get(fk)) === null, 'release: deletes the inflight row');
    ok((await cache.claimInflight(fk)) === true, 'inflight: free again after release');
    await cache.releaseInflight(fk);

    /* (11) retention: destructive (deletes every old row in the DB), so only on a scratch database */
    if (opts.prune) {
      const u11 = await mkUser('prune');
      const old = sql`(now() at time zone 'utc') - interval '40 days'`;
      const oldCache = sql`(now() at time zone 'utc') - interval '30 hours'`;
      await q(sql`delete from serp_cache where engine <> 'account'`);
      await q(sql`insert into serp_cache (key, engine, payload, fetched_at)
        select 'zzverify:pc-' || g, case when g % 3 = 0 then 'attempt' when g % 3 = 1 then 'inflight' else 'google_jobs' end, '{}'::jsonb, ${oldCache}
        from generate_series(1, 7) g`);
      await q(sql`insert into serp_cache (key, engine, payload, fetched_at) values
        ('zzverify:pc-fresh', 'google_jobs', '{}'::jsonb, now() at time zone 'utc'),
        ('account', 'account', '{"total_searches_left": 5}'::jsonb, ${oldCache})
        on conflict (key) do update set fetched_at = excluded.fetched_at, engine = excluded.engine`);
      const mk = async (name: string, status: string, updated: ReturnType<typeof sql>) => {
        const id = `${PREFIX}pr-${name}`;
        await q(sql`insert into agent_run (id, user_id, status, created_at, updated_at) values (${id}, ${u11}, ${status}, ${updated}, ${updated})`);
        await q(sql`insert into radar_search (run_id, key, engine) values (${id}, 'q0', 'google_jobs')`);
        return id;
      };
      const fresh = sql`(now() at time zone 'utc')`;
      await mk('old-done', 'done', old);
      await mk('old-error', 'error', old);
      await mk('old-cancelled', 'cancelled', old);
      await mk('old-awaiting', 'awaiting', old); // active: never pruned, however old
      await mk('new-done', 'done', fresh);
      const { pruneRadarData } = req('../lib/radar/housekeeping.ts') as typeof import('../lib/radar/housekeeping');
      const p1 = await pruneRadarData(db, { batch: 3, maxBatches: 1 });
      ok(p1.cacheRows === 3 && p1.more === true, 'prune: batch limit respected and reported (more: true)');
      const p2 = await pruneRadarData(db, { batch: 3, maxBatches: 10 });
      ok(p2.cacheRows === 4 && p2.more === false, 'prune: the next call finishes the rest in batches');
      ok(p1.runs + p2.runs === 3, 'prune: old terminal runs deleted (done, error, cancelled)');
      ok(Number((await q(sql`select count(*)::int as n from serp_cache where key like 'zzverify:pc-%'`))[0].n) === 1, 'prune: fresh cache row kept, 24h+ rows (incl. attempt/inflight) gone');
      ok(Number((await q(sql`select count(*)::int as n from serp_cache where key = 'account'`))[0].n) === 1, "prune: 'account' memo kept even when old");
      ok(Number((await q(sql`select count(*)::int as n from agent_run where id like ${PREFIX + 'pr-%'}`))[0].n) === 2, 'prune: new terminal run and old ACTIVE run kept');
      ok(Number((await q(sql`select count(*)::int as n from radar_search where run_id like ${PREFIX + 'pr-%'}`))[0].n) === 2, 'prune: ledger rows of pruned runs cascade away');
      await q(sql`insert into serp_cache (key, engine, payload, fetched_at) values ('zzverify:pc-late', 'google_jobs', '{}'::jsonb, ${oldCache})`);
      const pd = await pruneRadarData(db, { deadline: Date.now() - 1 });
      ok(pd.more === true && pd.cacheRows === 0 && pd.runs === 0, 'prune: an expired deadline is honoured BEFORE the first batch (nothing deleted, more: true)');
      await pruneRadarData(db);
      const p3 = await pruneRadarData(db);
      ok(p3.cacheRows === 0 && p3.runs === 0 && !p3.more, 'prune: idempotent, a second call deletes nothing');
    }
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
