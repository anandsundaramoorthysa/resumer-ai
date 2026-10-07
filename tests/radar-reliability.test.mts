/**
 * Job Radar production-reliability scenarios: async submit/poll protocol, never re-billing a
 * stored search, credit reservation, poison-step guard, IST day cap, stale runs, unavailable
 * guard. Stub deps and the in-memory stores only: no database, no network.
 */

import { assert, suiteAsync, testAsync } from './harness.mjs';
import {
  MAX_CLAIMS,
  POLL_CAP_MS,
  STEP_BUDGET_MS,
  LEASE_MS,
  advanceRadar,
  approveQueries,
  getRadar,
  istDayStart,
  memoryRunStore,
  startRadar,
} from '@/lib/radar/runs';
import type { RadarDeps, RadarStatus } from '@/lib/radar/runs';
import type { Posting, SearchPoll, SearchSubmit, SerpResult } from '@/lib/serp/types';

const posting = (n: number, fromQuery = 0): Posting => ({
  key: `k${n}`, title: `Engineer ${n}`, company: `Co${n}`, location: 'Pune', via: 'via X',
  description: 'Build React apps.', applyLinks: [], postedAt: '1 day ago', scheduleType: 'Full-time',
  salaryLpa: { min: 0, max: 0, source: 'none' }, highlights: ['React'], serpJobId: `job${n}`, fromQuery,
});

function make(over: Partial<RadarDeps> = {}) {
  let clock = Date.UTC(2026, 9, 7, 6);
  const now = () => clock;
  const store = memoryRunStore(now);
  const log = { submits: [] as string[], polls: 0, intel: 0, plan: 0, sleeps: 0 };
  /** What the fake SerpApi says per search id. */
  const archive = new Map<string, 'processing' | 'success' | 'error'>();
  const deps: RadarDeps = {
    store,
    now,
    sleep: async () => { log.sleeps++; },
    loadProfile: async () => ({ records: [], roles: [], contact: { fullName: 'A', email: 'a@b.c' } }),
    buildProfileDigest: () => 'digest',
    planSearch: async () => {
      log.plan++;
      return { queries: [{ q: 'qa', why: '' }, { q: 'qb', why: '' }], location: 'Pune', seniority: 'mid', rationale: '' };
    },
    rulesPlan: () => ({ queries: [], location: '', seniority: 'mid', rationale: '' }),
    warmBudget: async () => {},
    rankPostings: (ps) => ps.slice(0, 5).map((p, i) => ({ key: p.key, score: 90 - i, coveragePct: 50, matched: [], missing: [], reason: '' })),
    marketSignal: (ps) => ({ sampleSize: ps.length, salaryLpa: { p25: 0, median: 0, p75: 0, n: 0 }, topSkills: [], gapSkills: [] }),
    // A faithful async fake: reserve, then "send", then store the id.
    submitSearch: async (q, o): Promise<SearchSubmit> => {
      if (!(await o.reserve())) return { kind: 'declined' };
      log.submits.push(q);
      const id = `sid-${log.submits.length}-${q}`;
      archive.set(id, 'processing');
      await o.stored(id);
      return { kind: 'pending', searchId: id, shared: false };
    },
    pollSearch: async (q, o): Promise<SearchPoll> => {
      log.polls++;
      const st = archive.get(o.searchId);
      if (st === 'success') {
        const r: SerpResult<Posting[]> = { ok: true, data: [posting(o.fromQuery + 1, o.fromQuery)], cached: false, mode: 'live', credits: 1 };
        return { kind: 'result', result: r };
      }
      if (st === 'error') return { kind: 'result', result: { ok: false, reason: 'failed', message: 'x', refund: true } };
      return { kind: 'pending' };
    },
    companyIntel: async (company) => {
      log.intel++;
      return { ok: true, data: { company, rating: 4, ratingSource: 'x', reviewsCount: 1, headlines: [] }, cached: false, mode: 'live', credits: 2 };
    },
    newBudget: () => ({}) as never,
    aiAssert: async () => {},
    aiRecord: async () => {},
    ...over,
  };
  const step = (s: RadarStatus) => advanceRadar('u1', s.runId, s.step, deps);
  /** start -> plan -> approve [qa, qb]; returns the status at phase 'search'. */
  const toSearch = async (intel = false) => {
    let s = await startRadar('u1', { intel }, deps);
    s = await step(s);
    return approveQueries('u1', s.runId, ['qa', 'qb'], deps);
  };
  return { deps, store, log, archive, step, toSearch, tick: (ms: number) => (clock += ms), setClock: (t: number) => (clock = t) };
}

await suiteAsync('async search protocol', async () => {
  await testAsync('search submits and returns at once; poll repeats until settled; rank follows', async () => {
    const t = make();
    let s = await t.toSearch();
    s = await t.step(s);
    assert.equal(s.phase, 'poll');
    assert.equal(s.creditsUsed, 2, 'credits are reserved at submit, before any result exists');
    assert.equal(t.log.submits.length, 2);
    assert.equal(s.state.searches.length, 2);
    assert.ok(s.state.searches.every((x) => x.status === 'pending' && x.searchId.startsWith('sid-')));

    s = await t.step(s);
    assert.equal(s.phase, 'poll', 'nothing ready yet: stay in poll');
    assert.equal(t.log.sleeps, 1, 'a short pause between rounds');
    assert.equal(s.step, 4);

    t.archive.set(s.state.searches[0].searchId, 'success');
    s = await t.step(s);
    assert.equal(s.phase, 'poll', 'one of two settled');
    assert.equal(s.state.postings.length, 1);
    t.archive.set(s.state.searches[1].searchId, 'success');
    s = await t.step(s);
    assert.equal(s.phase, 'rank');
    assert.equal(s.state.postings.length, 2);
    assert.equal(s.state.okQueries, 2);
    assert.equal(t.log.submits.length, 2, 'polling never submits');
    assert.equal(s.creditsUsed, 2);
  });

  await testAsync('a search still pending after the cap is warned and skipped; the others still rank', async () => {
    const t = make();
    let s = await t.step(await t.toSearch());
    t.archive.set(s.state.searches[0].searchId, 'success');
    s = await t.step(s);
    t.tick(POLL_CAP_MS + 1_000);
    s = await t.step(s);
    assert.equal(s.phase, 'rank');
    assert.equal(s.state.okQueries, 1);
    assert.ok(s.events.some((e) => e.level === 'warn' && /did not finish/.test(e.message)));
    assert.equal(s.creditsUsed, 2, 'a timed-out search may still be billed: its reservation stands');
  });

  await testAsync('every search timing out is a hard, user-safe error', async () => {
    const t = make();
    let s = await t.step(await t.toSearch());
    t.tick(POLL_CAP_MS + 1_000);
    s = await t.step(s);
    assert.equal(s.status, 'error');
    assert.ok(/unavailable/.test(s.error));
  });

  await testAsync('poll Error is a refundable failure: the reservation is given back', async () => {
    const t = make();
    let s = await t.step(await t.toSearch());
    t.archive.set(s.state.searches[0].searchId, 'error');
    t.archive.set(s.state.searches[1].searchId, 'success');
    s = await t.step(s);
    assert.equal(s.phase, 'rank');
    assert.equal(s.creditsUsed, 1);
    assert.ok(s.events.some((e) => e.level === 'warn' && /failed/.test(e.message)));
  });

  await testAsync('a throwing poll counts as still pending, not as a failure', async () => {
    const t = make({ pollSearch: async () => { throw new Error('boom https://serpapi.com/?api_key=SECRET'); } });
    let s = await t.step(await t.toSearch());
    s = await t.step(s);
    assert.equal(s.phase, 'poll');
    assert.equal(s.status, 'running');
    assert.ok(!/SECRET/.test(JSON.stringify(s)));
  });

  await testAsync('REGRESSION: killed after submit, before commit, then reclaimed: zero extra submits', async () => {
    const t = make();
    const s0 = await t.toSearch();
    // The DB write that commits the step fails once, after both submits went out.
    const real = t.store.update.bind(t.store);
    let failOnce = true;
    t.store.update = async (id, where, patch) => {
      if (failOnce && patch.phase === 'poll') { failOnce = false; throw new Error('connection terminated'); }
      return real(id, where, patch);
    };
    await assert.rejects(advanceRadar('u1', s0.runId, s0.step, t.deps), /connection terminated/);
    assert.equal(t.log.submits.length, 2);
    assert.ok(t.store.runs[0].leasedUntil, 'the dead step still holds its lease');
    assert.equal((await advanceRadar('u1', s0.runId, s0.step, t.deps)).step, s0.step, 'blocked while leased');
    t.tick(LEASE_MS + 1_000); // the lease runs out
    const s1 = await advanceRadar('u1', s0.runId, s0.step, t.deps);
    assert.equal(t.log.submits.length, 2, 'NO query is submitted again');
    assert.equal(s1.phase, 'poll');
    assert.equal(s1.creditsUsed, 2, 'and nothing is reserved twice');
    assert.deepEqual(s1.state.searches.map((x) => x.searchId).sort(), [...t.archive.keys()].sort(), 'the stored ids are reused');
    assert.equal(t.store.runs[0].attempts, 0, 'the commit resets the claim counter');
  });

  await testAsync('a reservation without a stored id (died mid-send) is skipped, never re-sent', async () => {
    const t = make();
    const s0 = await t.toSearch();
    await t.store.reserve('u1', s0.runId, 'q0', { engine: 'google_jobs', q: 'qa', credits: 1 }, 12); // no setSearchId
    const s1 = await t.step(s0);
    assert.deepEqual(t.log.submits, ['qb'], 'only the query without a ledger row is sent');
    assert.equal(s1.creditsUsed, 2);
    assert.ok(s1.events.some((e) => /interrupted and is not retried/.test(e.message)));
    assert.equal(s1.state.searches[0].status, 'failed');
  });

  await testAsync('a killed run still counts its reserved credits toward the daily cap', async () => {
    const t = make();
    await t.step(await t.toSearch()); // 2 credits reserved
    t.store.runs[0].status = 'error'; // killed / failed afterwards
    assert.ok(t.store.runs[0].creditsUsed > 0);
    for (let i = 0; i < 2; i++) {
      t.store.runs.push({ ...structuredClone(t.store.runs[0]), id: `x${i}`, userId: 'u1' });
    }
    await assert.rejects(startRadar('u1', {}, t.deps), /Job Radar runs/);
  });

  await testAsync('the 12-credit run cap holds across reservations (atomic, before dispatch)', async () => {
    const t = make();
    const s0 = await t.toSearch(true);
    t.store.runs[0].creditsUsed = 11;
    const s1 = await t.step(s0);
    assert.deepEqual(t.log.submits, ['qa']);
    assert.equal(s1.creditsUsed, 12);
    assert.ok(s1.events.some((e) => /credit limit/.test(e.message)));
  });

  await testAsync('intel reserves 3 per company up front and settles to the real spend; a reclaimed step does not double-reserve', async () => {
    const t = make();
    let s = await t.toSearch(true);
    s = await t.step(s);
    for (const x of s.state.searches) t.archive.set(x.searchId, 'success');
    s = await t.step(s); // poll -> rank
    s = await t.step(s); // rank -> intel
    assert.equal(s.phase, 'intel');
    const before = s.creditsUsed;
    // A step that died after reserving company 0 (ledger row exists, nothing settled).
    await t.store.reserve('u1', s.runId, 'i0', { engine: 'intel', q: 'Co1', credits: 3 }, 12);
    s = await t.step(s);
    assert.equal(s.phase, 'select');
    // i0: reservation of 3 stands from the dead attempt (+3); i1: reserved 3, settled to 2.
    assert.equal(s.creditsUsed, before + 3 + 2);
    assert.equal(t.log.intel, 2);
  });
});

await suiteAsync('claims, attempts and leases', async () => {
  await testAsync('the lease outlives the function budget with a margin; Netlify/Vercel figures are documented', async () => {
    assert.ok(STEP_BUDGET_MS <= 30_000);
    assert.ok(LEASE_MS >= STEP_BUDGET_MS + 10_000);
  });

  await testAsync('claim() counts claims; a step claimed too often without committing fails the run safely', async () => {
    const t = make();
    const s = await startRadar('u1', {}, t.deps);
    for (let i = 1; i <= MAX_CLAIMS; i++) {
      const c = await t.store.claim('u1', s.runId, 0);
      assert.equal(c?.attempts, i);
      t.store.runs[0].leasedUntil = new Date(0); // the worker "died"
    }
    const r = await advanceRadar('u1', s.runId, 0, t.deps); // claim number MAX_CLAIMS + 1
    assert.equal(r.status, 'error');
    assert.equal(t.log.plan, 0, 'the poison step is not run again');
    assert.match(r.error, /stopped on our side/);
    assert.equal(r.events.at(-1)?.level, 'error');
  });

  await testAsync('a step that commits resets the counter, so long polls never trip the guard', async () => {
    const t = make();
    let s = await t.step(await t.toSearch());
    for (let i = 0; i < MAX_CLAIMS * 2; i++) s = await t.step(s);
    assert.equal(s.status, 'running');
    assert.equal(s.phase, 'poll');
    assert.equal(t.store.runs[0].attempts, 0);
  });
});

await suiteAsync('IST day cap and stale runs', async () => {
  await testAsync('istDayStart: the day rolls over at 18:30 UTC', async () => {
    const at = (h: number, m: number, d = 6) => Date.UTC(2026, 9, d, h, m, 0);
    assert.equal(istDayStart(at(18, 29)).toISOString(), '2026-10-05T18:30:00.000Z');
    assert.equal(istDayStart(at(18, 30)).toISOString(), '2026-10-06T18:30:00.000Z');
    assert.equal(istDayStart(at(0, 0)).toISOString(), '2026-10-05T18:30:00.000Z');
    assert.equal(istDayStart(at(18, 29, 7)).toISOString(), '2026-10-06T18:30:00.000Z');
  });

  await testAsync('3 runs per IST day: refused at 18:29 UTC, allowed again at 18:30 UTC; message says IST', async () => {
    const t = make();
    t.setClock(Date.UTC(2026, 9, 6, 17, 0));
    for (let i = 0; i < 3; i++) {
      const s = await startRadar('u1', {}, t.deps);
      t.store.runs.find((r) => r.id === s.runId)!.status = 'done';
    }
    t.setClock(Date.UTC(2026, 9, 6, 18, 29));
    await assert.rejects(startRadar('u1', {}, t.deps), /midnight IST/);
    t.setClock(Date.UTC(2026, 9, 6, 18, 30));
    assert.equal((await startRadar('u1', {}, t.deps)).status, 'running');
  });

  await testAsync('running runs go stale after 10 minutes, awaiting after 60; polls cancel them', async () => {
    const t = make();
    let s = await startRadar('u1', {}, t.deps);
    t.tick(9 * 60_000);
    assert.equal((await getRadar('u1', undefined, t.deps))?.status, 'running', '9 minutes: alive');
    t.tick(2 * 60_000);
    assert.equal(await getRadar('u1', undefined, t.deps), null, '11 minutes: cancelled');
    assert.equal(t.store.runs[0].status, 'cancelled');

    s = await t.step(await startRadar('u1', {}, t.deps)); // now awaiting-queries
    assert.equal(s.status, 'awaiting');
    t.tick(59 * 60_000);
    assert.equal((await getRadar('u1', undefined, t.deps))?.status, 'awaiting', '59 minutes at a gate: alive');
    t.tick(2 * 60_000);
    assert.equal((await getRadar('u1', s.runId, t.deps))?.status, 'cancelled', 'by run id too');
  });

  await testAsync('the stale cutoff is exact: alive AT 10 minutes (running) / 60 (awaiting), cancelled 1ms later', async () => {
    const t = make();
    await startRadar('u1', {}, t.deps);
    t.tick(10 * 60_000);
    assert.equal((await getRadar('u1', undefined, t.deps))?.status, 'running', 'exactly 10 minutes: still alive');
    t.tick(1);
    assert.equal(await getRadar('u1', undefined, t.deps), null, '10 minutes and 1ms: cancelled');

    const gate = await t.step(await startRadar('u1', {}, t.deps));
    assert.equal(gate.status, 'awaiting');
    t.tick(60 * 60_000);
    assert.equal((await getRadar('u1', gate.runId, t.deps))?.status, 'awaiting', 'exactly 60 minutes at a gate: alive');
    t.tick(1);
    assert.equal((await getRadar('u1', gate.runId, t.deps))?.status, 'cancelled');
  });

  await testAsync('cancelling a stale run advances its step by exactly one (a late writer from the old step is refused)', async () => {
    const t = make();
    const s = await startRadar('u1', {}, t.deps);
    const before = t.store.runs.find((r) => r.id === s.runId)!.step;
    t.tick(11 * 60_000);
    await getRadar('u1', s.runId, t.deps);
    const after = t.store.runs.find((r) => r.id === s.runId)!;
    assert.equal(after.status, 'cancelled');
    assert.equal(after.step, before + 1);
    // The step the run held when it was cancelled can no longer advance it.
    const late = await advanceRadar('u1', s.runId, before, t.deps);
    assert.equal(late.status, 'cancelled');
    assert.equal(t.store.runs.find((r) => r.id === s.runId)!.step, before + 1);
  });
});

await suiteAsync('guard unavailable', async () => {
  await testAsync('every search unavailable: a distinct, honest error and no sample data', async () => {
    const t = make({
      submitSearch: async () => ({ kind: 'result', result: { ok: false, reason: 'unavailable', message: 'Search is temporarily unavailable.' } }),
    });
    let s = await t.toSearch();
    s = await t.step(s);
    assert.equal(s.status, 'error');
    assert.match(s.error, /temporarily unavailable/);
    assert.equal(s.mode, 'live');
    assert.ok(!JSON.stringify(s).toLowerCase().includes('sample data'));
    assert.equal(s.creditsUsed, 0);
  });

  await testAsync('one unavailable, one fine: the run continues and says so', async () => {
    const t = make();
    let n = 0;
    const real = t.deps.submitSearch;
    t.deps.submitSearch = async (q, o) =>
      n++ === 0 ? { kind: 'result', result: { ok: false, reason: 'unavailable', message: 'x' } } : real(q, o);
    const s = await t.step(await t.toSearch());
    assert.equal(s.phase, 'poll');
    assert.ok(s.events.some((e) => /temporarily unavailable/.test(e.message)));
  });
});

await suiteAsync('bounded state, cancel race, metering', async () => {
  const { boundPostings, cutBytes, MAX_POSTINGS_BYTES } = await import('@/lib/radar/events');
  const bytes = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)).length;
  const cjk = (n: number) => '漢'.repeat(n);

  await testAsync('cutBytes cuts on a UTF-8 boundary and is exact for ASCII at the bound', async () => {
    assert.equal(cutBytes('a'.repeat(6000), 6000).length, 6000);
    assert.equal(cutBytes('a'.repeat(6001), 6000).length, 6000);
    const c = cutBytes(cjk(100), 100); // 100 bytes = 33 whole chars (99 bytes)
    assert.equal(c, cjk(33));
    assert.ok(!c.includes('\uFFFD'));
    assert.equal(cutBytes('é', 1), '', 'never half a character');
  });

  await testAsync('stored postings: 30 CJK postings stay under the byte budget; top 5 keep long text, the rest short', async () => {
    const big = (n: number): Posting => ({
      ...posting(n), title: cjk(300), company: cjk(200), via: cjk(100), description: cjk(5000),
      highlights: Array.from({ length: 20 }, () => cjk(400)),
      applyLinks: Array.from({ length: 9 }, () => ({ title: cjk(300), link: 'https://e.com/' + cjk(700) })),
    });
    const out = boundPostings(Array.from({ length: 40 }, (_, i) => big(i)));
    assert.ok(out.length >= 1 && out.length <= 30);
    assert.ok(bytes(out) <= MAX_POSTINGS_BYTES, `${bytes(out)} bytes`);
    assert.ok(out.every((p) => !p.description.includes('\uFFFD') && p.title.length <= 200));
    // ASCII postings: the documented tiers survive.
    const ascii = boundPostings(Array.from({ length: 30 }, (_, i) => ({ ...posting(i), description: 'a'.repeat(9000) })));
    assert.equal(ascii[0].description.length, 6000);
    assert.equal(ascii[4].description.length, 6000);
    assert.equal(ascii[5].description.length, 1500);
    assert.ok(bytes(ascii) <= MAX_POSTINGS_BYTES);
  });

  await testAsync('a whole run with CJK-heavy results never stores more than 150KB of state', async () => {
    const t = make({
      submitSearch: async (q, o): Promise<SearchSubmit> => {
        if (!(await o.reserve())) return { kind: 'declined' };
        const data = Array.from({ length: 25 }, (_, i) => ({ ...posting(o.fromQuery * 100 + i, o.fromQuery), description: cjk(5000), highlights: [cjk(400), cjk(400)] }));
        return { kind: 'result', result: { ok: true, data, cached: false, mode: 'live', credits: 1 } };
      },
    });
    let s = await t.toSearch(true);
    for (let i = 0; i < 8 && s.status === 'running'; i++) s = await t.step(s);
    assert.ok(bytes(t.store.runs[0].state) < 150_000, `${bytes(t.store.runs[0].state)} bytes`);
  });

  await testAsync('cancel survives a commit racing it (compare-and-set lost once, then retried)', async () => {
    const t = make();
    const s = await t.toSearch();
    const real = t.store.update.bind(t.store);
    let raced = false;
    t.store.update = async (id, where, patch) => {
      if (!raced && patch.status === 'cancelled') {
        raced = true;
        t.store.runs[0].step += 1; // a step committed between the cancel's read and its write
      }
      return real(id, where, patch);
    };
    const { cancelRadar } = await import('@/lib/radar/runs');
    const r = await cancelRadar('u1', s.runId, t.deps);
    assert.equal(r.status, 'cancelled');
    assert.ok(raced);
  });

  await testAsync('the plan step meters AI usage per user as it goes (a killed plan step is not free)', async () => {
    const seen: string[] = [];
    const t = make({ newBudget: ((userId: string) => (seen.push(userId), {})) as never });
    await t.step(await startRadar('u1', {}, t.deps));
    assert.deepEqual(seen, ['u1']);
  });
});
