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
import type { Posting, SerpResult } from '@/lib/serp/types';

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

interface Calls { search: string[]; intel: string[]; plan: number; rank: number }

function make(over: Partial<RadarDeps> = {}) {
  const calls: Calls = { search: [], intel: [], plan: 0, rank: 0 };
  const store = memoryRunStore();
  let clock = Date.UTC(2026, 9, 6, 12);
  const ok = <T,>(data: T, mode: 'live' | 'replay' = 'live', credits = 1): SerpResult<T> => ({
    ok: true, data, cached: false, mode, credits,
  });
  const deps: RadarDeps = {
    store,
    now: () => (clock += 1),
    loadProfile: async () => ({ records: [], roles: [], contact: { fullName: 'A', email: 'a@b.c' } }),
    buildProfileDigest: () => 'digest',
    planSearch: async () => {
      calls.plan += 1;
      return {
        queries: [{ q: 'react developer Bengaluru', why: 'a' }, { q: 'frontend engineer Bengaluru', why: 'b' }],
        location: 'Bengaluru', seniority: 'mid', rationale: 'r',
      };
    },
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
    searchJobs: async (q, o) => {
      calls.search.push(q);
      return ok([posting(o.fromQuery * 10 + 1, o.fromQuery), posting(o.fromQuery * 10 + 2, o.fromQuery)]);
    },
    companyIntel: async (company) => {
      calls.intel.push(company);
      return ok({ company, rating: 4, ratingSource: 'x', reviewsCount: 1, headlines: [] }, 'live', 2);
    },
    newBudget: () => ({}) as never,
    aiAssert: async () => {},
    aiRecord: async () => {},
    ...over,
  };
  /** Advance until the run stops running; returns the final status. */
  const drive = async (s: RadarStatus, userId = 'u1'): Promise<RadarStatus> => {
    let guard = 0;
    while (s.status === 'running' && guard++ < 40) s = await advanceRadar(userId, s.runId, s.step, deps);
    return s;
  };
  return { deps, calls, store, drive };
}

await suiteAsync('radar state machine', async () => {
  await testAsync('happy path: plan -> G1 -> search -> rank -> intel -> market -> G2 -> done', async () => {
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

  await testAsync('per-user daily run cap', async () => {
    const t = make();
    for (let i = 0; i < 3; i++) {
      const s = await startRadar('u1', {}, t.deps);
      await cancelRadar('u1', s.runId, t.deps);
    }
    await assert.rejects(startRadar('u1', {}, t.deps), /Job Radar runs/);
    const other = await startRadar('u2', {}, t.deps);
    assert.equal(other.status, 'running');
  });

  await testAsync('starting again while a run is active returns that run', async () => {
    const t = make();
    const a = await startRadar('u1', {}, t.deps);
    const b = await startRadar('u1', {}, t.deps);
    assert.equal(a.runId, b.runId);
  });

  await testAsync('per-run credit cap skips searches past the limit', async () => {
    const t = make({
      searchJobs: async (q, o) => ({ ok: true, data: [posting(o.fromQuery + 1, o.fromQuery)], cached: false, mode: 'live', credits: 12 }),
    });
    let s = await t.drive(await startRadar('u1', { intel: false }, t.deps));
    s = await t.drive(await approveQueries('u1', s.runId, ['a', 'b'], t.deps));
    assert.equal(s.gate, 'select');
    assert.equal(s.creditsUsed, 12);
    assert.equal(s.state.postings.length, 1);
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
    assert.ok(stored.every((p) => p.description.length <= 4_000));
    assert.ok(JSON.stringify(t.store.runs[0].state).length < 200_000);
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
});
