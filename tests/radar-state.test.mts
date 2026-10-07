/** Radar orchestrator with stub deps and an in-memory store: no database, no network, no model. */

import { assert, suiteAsync, testAsync } from './harness.mjs';
import {
  advanceRadar,
  approveQueries,
  cancelRadar,
  getRadar,
  memoryRunStore,
  selectPosting,
  startRadar,
} from '@/lib/radar/runs';
import type { RadarDeps, RadarStatus } from '@/lib/radar/runs';
import { MAX_EVENTS } from '@/lib/radar/events';
import { MAX_JOB_INPUT_CHARS } from '@/lib/intake/job-input';
import { BudgetExceededError } from '@/lib/ai/budget';
import type { Posting, SearchPoll, SearchSubmit, SerpResult } from '@/lib/serp/types';

type StubSearch = (q: string, o: { userId: string; fromQuery: number }) => Promise<SerpResult<Posting[]>>;

const posting = (n: number, fromQuery = 0, description = 'Build React apps.'): Posting => ({
  key: `k${n}`,
  title: `Engineer ${n}`,
  company: `Co${n}`,
  location: 'Bengaluru',
  via: 'via X',
  description,
  applyLinks: [{ title: 'Apply', link: 'https://example.com/apply' }],
  postedAt: '1 day ago',
  scheduleType: 'Full-time',
  salaryLpa: { min: 0, max: 0, source: 'none' },
  highlights: ['React', 'TypeScript'],
  serpJobId: `job${n}`,
  fromQuery,
});

interface Calls { search: string[]; intel: string[]; plan: number; rank: number; warm: number }

function make(over: Partial<RadarDeps> & { searchJobs?: StubSearch } = {}) {
  const { searchJobs: stubSearch, ...depsOver } = over;
  const calls: Calls = { search: [], intel: [], plan: 0, rank: 0, warm: 0 };
  let clock = Date.UTC(2026, 9, 6, 12);
  const now = () => (clock += 1);
  const store = memoryRunStore(now);
  const ok = <T,>(data: T, mode: 'live' | 'replay' = 'live', credits = 1): SerpResult<T> => ({
    ok: true, data, cached: false, mode, credits,
  });
  const stub: { searchJobs: StubSearch } = {
    searchJobs:
      stubSearch ??
      (async (q, o) => {
        calls.search.push(q);
        return ok([posting(o.fromQuery * 10 + 1, o.fromQuery), posting(o.fromQuery * 10 + 2, o.fromQuery)]);
      }),
  };
  const deps: RadarDeps = {
    store,
    now,
    loadProfile: async () => ({ records: [], roles: [], contact: { fullName: 'A', email: 'a@b.c' } }),
    buildProfileDigest: () => 'digest',
    planSearch: async () => {
      calls.plan += 1;
      return {
        queries: [{ q: 'react developer Bengaluru', why: 'a' }, { q: 'frontend engineer Bengaluru', why: 'b' }],
        location: 'Bengaluru', seniority: 'mid', rationale: 'r',
      };
    },
    rulesPlan: () => ({
      queries: [{ q: 'rules role Bengaluru', why: 'rules' }],
      location: 'Bengaluru', seniority: 'mid', rationale: 'rules',
    }),
    warmBudget: async () => { calls.warm += 1; },
    rankPostings: (postings) => {
      calls.rank += 1;
      return postings.slice(0, 5).map((p, i) => ({
        key: p.key, score: 90 - i, coveragePct: 50, matched: ['react'], missing: [], reason: 'fit',
      }));
    },
    marketSignal: (postings) => ({
      sampleSize: postings.length,
      salaryLpa: { p25: 0, median: 0, p75: 0, n: 0 },
      topSkills: [], gapSkills: [],
    }),
    // The stepped orchestrator submits then polls; this default answers at submit time (a cache or replay hit).
    submitSearch: async (q, o): Promise<SearchSubmit> => {
      if (!(await o.reserve())) return { kind: 'declined' }; // as the live path does, right before sending
      return { kind: 'result', result: await stub.searchJobs(q, o) };
    },
    pollSearch: async (): Promise<SearchPoll> => ({ kind: 'pending' }),
    sleep: async () => {},
    companyIntel: async (company) => {
      calls.intel.push(company);
      return ok({ company, rating: 4, ratingSource: 'x', reviewsCount: 1, headlines: [] }, 'live', 2);
    },
    newBudget: () => ({}) as never,
    aiAssert: async () => {},
    aiRecord: async () => {},
    ...depsOver,
  };
  /** Advance until the run stops running; returns the final status. */
  const drive = async (s: RadarStatus, userId = 'u1'): Promise<RadarStatus> => {
    let guard = 0;
    while (s.status === 'running' && guard++ < 40) s = await advanceRadar(userId, s.runId, s.step, deps);
    return s;
  };
  /** Start, approve and finish a run (counts toward the daily cap). */
  const finish = async (userId = 'u1') => {
    let s = await drive(await startRadar(userId, { intel: false }, deps), userId);
    s = await approveQueries(userId, s.runId, ['a'], deps);
    s = await drive(s, userId);
    return selectPosting(userId, s.runId, s.state.postings[0].key, deps);
  };
  return { deps, calls, store, drive, finish, now, stub };
}

await suiteAsync('radar state machine', async () => {
  await testAsync('happy path: plan -> G1 -> search -> rank -> intel -> G2 -> done', async () => {
    const t = make();
    let s = await startRadar('u1', {}, t.deps);
    assert.equal(s.phase, 'plan');
    s = await t.drive(s);
    assert.equal(s.status, 'awaiting');
    assert.equal(s.gate, 'queries');
    assert.equal(s.state.queries.length, 2);
    assert.equal(t.calls.search.length, 0, 'no credits before G1');

    s = await approveQueries('u1', s.runId, s.state.queries.map((x) => x.q), t.deps);
    assert.equal(s.status, 'running');
    s = await t.drive(s);
    assert.equal(s.status, 'awaiting');
    assert.equal(s.gate, 'select');
    assert.equal(t.calls.search.length, 2);
    assert.deepEqual(t.calls.intel, ['Co1', 'Co2']);
    assert.equal(s.state.postings.length, 4);
    assert.equal(s.state.intel.length, 2);
    assert.ok(s.state.market);
    assert.equal(s.creditsUsed, 1 + 1 + 2 + 2);

    const sel = await selectPosting('u1', s.runId, 'k11', t.deps);
    assert.equal(sel.status, 'done');
    assert.equal(sel.state.selectedKey, 'k11');
    assert.ok(sel.jobText.includes('Build React apps.'));
    assert.ok(!/^https?:/.test(sel.jobText));
    assert.equal((await getRadar('u1', undefined, t.deps)), null, 'done run is not active');
    assert.equal((await getRadar('u1', s.runId, t.deps))?.status, 'done');
  });

  await testAsync('intel disabled skips intel steps and its credits', async () => {
    const t = make();
    let s = await startRadar('u1', { intel: false }, t.deps);
    s = await t.drive(s);
    s = await approveQueries('u1', s.runId, ['react developer'], t.deps);
    s = await t.drive(s);
    assert.equal(s.gate, 'select');
    assert.equal(t.calls.intel.length, 0);
    assert.equal(s.creditsUsed, 1);
  });

  await testAsync('G1 edits: removed queries never run, blank list refused', async () => {
    const t = make();
    let s = await t.drive(await startRadar('u1', {}, t.deps));
    await assert.rejects(approveQueries('u1', s.runId, ['  ', ''], t.deps), /at least one/);
    s = await approveQueries('u1', s.runId, ['  my   own query '], t.deps);
    assert.deepEqual(s.state.queries.map((q) => q.q), ['my own query']);
    await t.drive(s);
    assert.deepEqual(t.calls.search, ['my own query']);
  });

  await testAsync('cancel stops the run; advance after cancel is a no-op', async () => {
    const t = make();
    const s = await startRadar('u1', {}, t.deps);
    const c = await cancelRadar('u1', s.runId, t.deps);
    assert.equal(c.status, 'cancelled');
    const after = await advanceRadar('u1', s.runId, c.step, t.deps);
    assert.equal(after.status, 'cancelled');
    assert.equal(after.step, c.step);
    assert.equal(t.calls.plan, 0);
    assert.equal((await cancelRadar('u1', s.runId, t.deps)).step, c.step);
  });

  await testAsync('wrong expectStep returns current status and does no work', async () => {
    const t = make();
    const s = await startRadar('u1', {}, t.deps);
    const r = await advanceRadar('u1', s.runId, s.step + 5, t.deps);
    assert.equal(r.step, s.step);
    assert.equal(t.calls.plan, 0);
    // The same step twice: the second sees a moved step and does nothing.
    await advanceRadar('u1', s.runId, s.step, t.deps);
    const dup = await advanceRadar('u1', s.runId, s.step, t.deps);
    assert.equal(t.calls.plan, 1);
    assert.equal(dup.step, s.step + 1);
  });

  await testAsync('a run belongs to its user', async () => {
    const t = make();
    const s = await startRadar('u1', {}, t.deps);
    await assert.rejects(advanceRadar('u2', s.runId, 0, t.deps), /not found/);
    assert.equal(await getRadar('u2', s.runId, t.deps), null);
  });

  await testAsync('one failing query is a warn and skipped', async () => {
    const t = make({
      searchJobs: async (q, o) =>
        o.fromQuery === 0
          ? { ok: false, reason: 'failed', message: 'GET https://serpapi.com/x?api_key=SECRET failed' }
          : { ok: true, data: [posting(7, 1)], cached: false, mode: 'live', credits: 1 },
    });
    let s = await t.drive(await startRadar('u1', { intel: false }, t.deps));
    s = await t.drive(await approveQueries('u1', s.runId, ['a', 'b'], t.deps));
    assert.equal(s.gate, 'select');
    assert.equal(s.state.postings.length, 1);
    const warn = s.events.find((e) => e.level === 'warn');
    assert.ok(warn);
    const shown = JSON.stringify([s.events, s.error, s.message]);
    assert.ok(!shown.includes('SECRET') && !shown.includes('https://'));
  });

  await testAsync('every search failing is a hard, user-safe error', async () => {
    const t = make({
      searchJobs: async () => ({ ok: false, reason: 'failed', message: 'boom api_key=SECRET' }),
    });
    let s = await t.drive(await startRadar('u1', {}, t.deps));
    s = await t.drive(await approveQueries('u1', s.runId, ['a', 'b'], t.deps));
    assert.equal(s.status, 'error');
    assert.ok(s.error.length > 0);
    assert.ok(!/SECRET|api_key/.test(JSON.stringify(s)));
    assert.equal(s.events.at(-1)?.level, 'error');
  });

  await testAsync('a throwing dependency never leaks its message', async () => {
    const t = make({
      planSearch: async () => { throw new TypeError('Failed query: select * from users where key=sk-123'); },
    });
    const s = await t.drive(await startRadar('u1', {}, t.deps));
    assert.equal(s.status, 'error');
    assert.ok(!/select|sk-123/.test(s.error));
  });

  await testAsync('per-user daily run cap counts finished runs, not ones cancelled before a search', async () => {
    const t = make();
    for (let i = 0; i < 5; i++) {
      const s = await startRadar('u1', {}, t.deps);
      await cancelRadar('u1', s.runId, t.deps);
    }
    for (let i = 0; i < 3; i++) await t.finish();
    await assert.rejects(startRadar('u1', {}, t.deps), /Job Radar runs/);
    const other = await startRadar('u2', {}, t.deps);
    assert.equal(other.status, 'running');
  });

  await testAsync('a run that errored after spending credits counts toward the cap', async () => {
    const t = make();
    await startRadar('u1', {}, t.deps);
    t.store.runs[0].status = 'error';
    for (let i = 1; i < 4; i++) {
      t.store.runs.push({ ...structuredClone(t.store.runs[0]), id: `x${i}`, creditsUsed: 1 });
    }
    await assert.rejects(startRadar('u1', {}, t.deps), /Job Radar runs/);
    t.store.runs.pop();
    assert.equal((await startRadar('u1', {}, t.deps)).status, 'running');
  });

  await testAsync('starting again while a run is active returns that run', async () => {
    const t = make();
    const a = await startRadar('u1', {}, t.deps);
    const b = await startRadar('u1', {}, t.deps);
    assert.equal(a.runId, b.runId);
  });

  await testAsync('per-run credit cap skips searches past the limit (checked before dispatch)', async () => {
    const t = make();
    let s = await t.drive(await startRadar('u1', { intel: false }, t.deps));
    s = await approveQueries('u1', s.runId, ['a', 'b'], t.deps);
    t.store.runs[0].creditsUsed = 11;
    s = await t.drive(s);
    assert.equal(s.gate, 'select');
    assert.deepEqual(t.calls.search, ['a']);
    assert.equal(s.creditsUsed, 12);
    assert.ok(s.events.some((e) => e.level === 'warn' && /credit limit/.test(e.message)));
  });

  await testAsync('replay result sets mode and adds one visible banner event', async () => {
    const t = make({
      searchJobs: async (q, o) => ({ ok: true, data: [posting(o.fromQuery + 1, o.fromQuery)], cached: false, mode: 'replay', credits: 0 }),
    });
    let s = await t.drive(await startRadar('u1', { intel: false }, t.deps));
    s = await t.drive(await approveQueries('u1', s.runId, ['a', 'b'], t.deps));
    assert.equal(s.mode, 'replay');
    assert.equal(s.events.filter((e) => /sample data/.test(e.message)).length, 1);
    assert.equal(s.creditsUsed, 0);
  });

  await testAsync('event log is capped at 60, keeping the newest', async () => {
    const t = make();
    const s = await startRadar('u1', {}, t.deps);
    t.store.runs[0].events = Array.from({ length: 80 }, (_, i) => ({
      at: 'x', level: 'info' as const, phase: 'p', message: `old${i}`,
    }));
    const r = await advanceRadar('u1', s.runId, s.step, t.deps);
    assert.equal(r.events.length, MAX_EVENTS);
    assert.equal(r.events.at(-1)?.source, 'planner');
    assert.equal(r.events[0].message, 'old21');
  });

  await testAsync('stored state is bounded: 30 postings, descriptions truncated; jobText capped', async () => {
    const huge = 'x'.repeat(60_000);
    const t = make({
      searchJobs: async (q, o) => ({
        ok: true,
        data: Array.from({ length: 25 }, (_, i) => posting(o.fromQuery * 100 + i, o.fromQuery, huge)),
        cached: false, mode: 'live', credits: 1,
      }),
    });
    let s = await t.drive(await startRadar('u1', { intel: false }, t.deps));
    s = await t.drive(await approveQueries('u1', s.runId, ['a', 'b'], t.deps));
    const stored = t.store.runs[0].state.postings;
    assert.equal(stored.length, 30);
    assert.ok(stored.every((p, i) => p.description.length <= (i < 5 ? 6_000 : 1_500)), 'long text only for the first 5');
    assert.ok(new TextEncoder().encode(JSON.stringify(t.store.runs[0].state)).length < 150_000);
    assert.ok(s.state.postings.every((p) => p.description.length <= 300), 'polls stay light');
    const sel = await selectPosting('u1', s.runId, stored[0].key, t.deps);
    assert.ok(sel.jobText.length <= MAX_JOB_INPUT_CHARS);
    assert.ok(sel.jobText.length > 3_000);
  });

  await testAsync('selecting an unknown key is refused', async () => {
    const t = make();
    let s = await t.drive(await startRadar('u1', {}, t.deps));
    s = await t.drive(await approveQueries('u1', s.runId, ['a'], t.deps));
    await assert.rejects(selectPosting('u1', s.runId, 'nope', t.deps), /not part of this run/);
  });
  await testAsync('phases: plan -> awaiting-queries -> search -> rank -> intel -> select -> done', async () => {
    const t = make();
    const seen: string[] = [];
    let s = await startRadar('u1', {}, t.deps);
    seen.push(s.phase);
    const total = s.totalSteps;
    while (s.status === 'running') { s = await advanceRadar('u1', s.runId, s.step, t.deps); seen.push(s.phase); }
    s = await approveQueries('u1', s.runId, ['a', 'b'], t.deps);
    seen.push(s.phase);
    while (s.status === 'running') { s = await advanceRadar('u1', s.runId, s.step, t.deps); seen.push(s.phase); }
    s = await selectPosting('u1', s.runId, 'k1', t.deps);
    seen.push(s.phase);
    assert.deepEqual(seen, ['plan', 'awaiting-queries', 'search', 'rank', 'intel', 'select', 'done']);
    assert.equal(total, 7, 'plan, G1, search, poll, rank, intel, G2/done');
    assert.equal(s.step, 6, 'no poll round needed (answered at submit): one short of the total');
    assert.ok(s.state.market && s.state.ranked.length > 0, 'market computed in the rank step');
    assert.equal(t.calls.rank, 1);
  });

  await testAsync('intel off: rank goes straight to the select gate', async () => {
    const t = make();
    let s = await t.drive(await startRadar('u1', { intel: false }, t.deps));
    assert.equal(s.totalSteps, 6);
    s = await approveQueries('u1', s.runId, ['a'], t.deps);
    s = await advanceRadar('u1', s.runId, s.step, t.deps);
    assert.equal(s.phase, 'rank');
    s = await advanceRadar('u1', s.runId, s.step, t.deps);
    assert.equal(s.phase, 'select');
    assert.equal(s.gate, 'select');
    assert.ok(s.state.market);
  });

  await testAsync('two concurrent advances of one step do the work once (lease)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const t = make();
    const inner = t.deps.planSearch;
    t.deps.planSearch = async (a) => { await gate; return inner(a); };
    const s = await startRadar('u1', {}, t.deps);
    const both = Promise.all([
      advanceRadar('u1', s.runId, s.step, t.deps),
      advanceRadar('u1', s.runId, s.step, t.deps),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await both;
    assert.equal(t.calls.plan, 1);
    assert.deepEqual([a.step, b.step].sort(), [0, 1], 'the loser reports the run unchanged');
  });

  await testAsync('a crashed step is reclaimable once its lease expires', async () => {
    const t = make();
    const s = await startRadar('u1', {}, t.deps);
    assert.ok(await t.store.claim('u1', s.runId, 0), 'worker claims, then dies');
    const blocked = await advanceRadar('u1', s.runId, 0, t.deps);
    assert.equal(blocked.step, 0);
    assert.equal(t.calls.plan, 0);
    t.store.runs[0].leasedUntil = new Date(0);
    const after = await advanceRadar('u1', s.runId, 0, t.deps);
    assert.equal(t.calls.plan, 1);
    assert.equal(after.phase, 'awaiting-queries');
    assert.equal(t.store.runs[0].leasedUntil, null, 'commit clears the lease');
  });

  await testAsync('claims and updates are scoped to the user', async () => {
    const t = make();
    const s = await startRadar('u1', {}, t.deps);
    assert.equal(await t.store.claim('u2', s.runId, 0), null);
    assert.equal(await t.store.update(s.runId, { userId: 'u2', step: 0 }, { message: 'x' }), null);
  });

  await testAsync('four concurrent starts return one run', async () => {
    const t = make();
    const all = await Promise.all([1, 2, 3, 4].map(() => startRadar('u1', {}, t.deps)));
    assert.equal(new Set(all.map((x) => x.runId)).size, 1);
    assert.equal(t.store.runs.length, 1);
  });

  await testAsync('daily AI allowance spent: the plan step falls back to rules and the run continues', async () => {
    const t = make({ aiAssert: async () => { throw new BudgetExceededError('daily', '9/9 calls today'); } });
    const s = await t.drive(await startRadar('u1', {}, t.deps));
    assert.equal(s.status, 'awaiting');
    assert.equal(s.gate, 'queries');
    assert.equal(t.calls.plan, 0);
    assert.deepEqual(s.state.queries.map((q) => q.q), ['rules role Bengaluru']);
    assert.ok(s.events.some((e) => e.level === 'info' && /AI allowance reached, using a rules-based plan/.test(e.message)));
  });

  await testAsync('a burst limit in the plan step is rethrown, commits nothing, and frees the step', async () => {
    let limited = true;
    const t = make({ aiAssert: async () => { if (limited) throw new BudgetExceededError('rate', 'too fast'); } });
    const s = await startRadar('u1', {}, t.deps);
    await assert.rejects(advanceRadar('u1', s.runId, 0, t.deps), (e: Error) => e.name === 'BudgetExceededError');
    assert.equal(t.store.runs[0].status, 'running');
    assert.equal(t.store.runs[0].step, 0);
    assert.equal(t.store.runs[0].leasedUntil, null);
    limited = false;
    assert.equal((await advanceRadar('u1', s.runId, 0, t.deps)).phase, 'awaiting-queries');
  });

  await testAsync('a transient error retries the step, then fails after 3 attempts with a safe message', async () => {
    let n = 0;
    const flaky = make({
      planSearch: async () => {
        if (n++ < 2) throw new TypeError('connection reset by 10.0.0.5');
        return { queries: [{ q: 'q', why: '' }], location: 'x', seniority: 'mid', rationale: '' };
      },
    });
    let s = await startRadar('u1', {}, flaky.deps);
    s = await advanceRadar('u1', s.runId, s.step, flaky.deps);
    assert.equal(s.status, 'running');
    assert.equal(s.state.retries, 1);
    s = await advanceRadar('u1', s.runId, s.step, flaky.deps);
    assert.equal(s.status, 'running');
    s = await advanceRadar('u1', s.runId, s.step, flaky.deps);
    assert.equal(s.status, 'awaiting');
    assert.equal(s.state.retries, 0, 'success resets the counter');

    const dead = make({ planSearch: async () => { throw new TypeError('db down at 10.0.0.5:5432'); } });
    s = await startRadar('u1', {}, dead.deps);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) { s = await advanceRadar('u1', s.runId, s.step, dead.deps); seen.push(s.status); }
    assert.deepEqual(seen, ['running', 'running', 'error']);
    assert.ok(!/10\.0\.0\.5/.test(JSON.stringify(s)));
  });

  await testAsync('an authored error (nothing to search for) fails at once, not after retries', async () => {
    const t = make({ planSearch: async () => ({ queries: [], location: '', seniority: 'mid', rationale: '' }) });
    let s = await startRadar('u1', {}, t.deps);
    s = await advanceRadar('u1', s.runId, s.step, t.deps);
    assert.equal(s.status, 'error');
    assert.match(s.error, /Add a role or skill/);
  });

  await testAsync('a run idle for over an hour is auto-cancelled so it cannot block the user', async () => {
    const t = make();
    const old = await startRadar('u1', {}, t.deps);
    t.store.runs[0].updatedAt = new Date(t.now() - 61 * 60_000);
    assert.equal(await getRadar('u1', undefined, t.deps), null);
    assert.equal(t.store.runs[0].status, 'cancelled');
    const fresh = await startRadar('u1', {}, t.deps);
    assert.notEqual(fresh.runId, old.runId);
    // A recent run is left alone.
    assert.equal((await startRadar('u1', {}, t.deps)).runId, fresh.runId);
  });

  await testAsync('search runs every query in parallel once, isolating failures (even throws)', async () => {
    let inflight = 0;
    let peak = 0;
    const t = make();
    t.stub.searchJobs = async (q, o) => {
      inflight += 1; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
      t.calls.search.push(q);
      if (o.fromQuery === 1) throw new Error('boom https://serpapi.com/?api_key=SECRET');
      return { ok: true, data: [posting(o.fromQuery + 1, o.fromQuery)], cached: false, mode: 'live', credits: 1 };
    };
    let s = await t.drive(await startRadar('u1', { intel: false }, t.deps));
    s = await approveQueries('u1', s.runId, ['a', 'b', 'c'], t.deps);
    s = await advanceRadar('u1', s.runId, s.step, t.deps);
    assert.equal(s.phase, 'rank', 'one step covers all queries');
    assert.deepEqual([...t.calls.search].sort(), ['a', 'b', 'c']);
    assert.equal(peak, 3);
    assert.equal(t.calls.warm, 1, 'budget memo primed once before the fan-out');
    assert.equal(s.state.postings.length, 2);
    assert.equal(s.events.filter((e) => e.level === 'warn').length, 1);
    assert.ok(!/SECRET|serpapi\.com/.test(JSON.stringify([s.events, s.error, s.message])));
    assert.equal(s.creditsUsed, 3, 'the call that threw may have been billed: its reservation stands');
  });

  await testAsync('intel looks up both companies in one step', async () => {
    const t = make();
    let s = await t.drive(await startRadar('u1', {}, t.deps));
    s = await approveQueries('u1', s.runId, ['a', 'b'], t.deps);
    s = await advanceRadar('u1', s.runId, s.step, t.deps);
    s = await advanceRadar('u1', s.runId, s.step, t.deps);
    assert.equal(s.phase, 'intel');
    s = await advanceRadar('u1', s.runId, s.step, t.deps);
    assert.deepEqual(t.calls.intel, ['Co1', 'Co2']);
    assert.equal(s.phase, 'select');
  });

  await testAsync('untrusted strings and lists kept in state are bounded', async () => {
    const big = (n: number) => 'z'.repeat(n);
    const t = make({
      searchJobs: async () => ({
        ok: true, cached: false, mode: 'live', credits: 1,
        data: [{
          ...posting(1), title: big(900), company: big(900), via: big(900),
          applyLinks: Array.from({ length: 40 }, () => ({ title: big(900), link: big(5000) })),
          highlights: Array.from({ length: 60 }, () => big(900)),
        }],
      }),
    });
    const s = await t.drive(await startRadar('u1', { intel: false }, t.deps));
    await t.drive(await approveQueries('u1', s.runId, ['a'], t.deps));
    const p = t.store.runs[0].state.postings[0];
    assert.ok(p.title.length <= 200 && p.company.length <= 120 && p.via.length <= 60);
    assert.ok(p.applyLinks.length <= 5 && p.applyLinks.every((l) => l.link.length <= 500));
    assert.ok(p.highlights.length <= 8 && p.highlights.every((h) => h.length <= 200));
  });
});
