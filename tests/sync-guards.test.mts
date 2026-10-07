/**
 * The step guard (lib/sync/guards.ts) over the in-memory model: two requests for the same
 * step run it once, a stale write cannot overwrite a newer one, and the lease is hidden
 * from callers and expires. The same SQL is proven against Postgres by
 * scripts/verify-sync-db.mts.
 */

import { guardedStep, jobResult, leaseLive, memoryJobStore, visibleError } from '../lib/sync/guards';
import type { Job, StepWork } from '../lib/sync/guards';
import { suiteAsync, testAsync, assert } from './harness.mjs';

const seed = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  userId: 'u1',
  status: 'running',
  step: 1,
  totalSteps: 4,
  message: 'start',
  sha: null,
  corpus: null,
  partials: [],
  error: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const described = (e: unknown) => (e instanceof Error ? e.message : 'x');
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

const advanceTo = (n: number, message: string): StepWork => ({
  patch: { step: n, message },
  result: { step: n, status: 'running', message, done: false },
});

await suiteAsync('two requests for one step', async () => {
  await testAsync('REPRO: both tabs read step 1 — the slice now runs exactly once', async () => {
    const store = memoryJobStore([seed()]);
    let runs = 0;
    const g = gate();
    const work = async (): Promise<StepWork> => {
      runs += 1;
      await g.p; // the second request arrives while the first is mid-extraction
      return advanceTo(2, 'slice read');
    };
    const a = guardedStep(store, 'u1', 'j1', work, described);
    const b = guardedStep(store, 'u1', 'j1', work, described);
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(runs, 1, 'only one request may spend');
    const winner = [ra, rb].filter((r) => !r.stale);
    const loser = [ra, rb].filter((r) => r.stale);
    assert.equal(winner.length, 1);
    assert.equal(loser.length, 1);
    assert.equal(winner[0].step, 2);
    assert.equal(store.jobs.get('j1')!.step, 2);
  });

  await testAsync('the loser gets the current status, unchanged, and writes nothing', async () => {
    const store = memoryJobStore([seed({ partials: [{ a: 1 }] })]);
    const g = gate();
    const slow = guardedStep(store, 'u1', 'j1', async () => {
      await g.p;
      return { ...advanceTo(2, 'first'), patch: { step: 2, message: 'first', partials: [{ a: 1 }, { b: 2 }] } };
    }, described);
    let ran = false;
    const stale = await guardedStep(store, 'u1', 'j1', async () => {
      ran = true;
      return { ...advanceTo(2, 'second'), patch: { step: 2, message: 'second', partials: [{ c: 3 }] } };
    }, described);
    assert.equal(ran, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.status, 'running');
    assert.equal(stale.step, 1);
    assert.equal(stale.message, 'start');
    g.open();
    await slow;
    assert.deepEqual(store.jobs.get('j1')!.partials, [{ a: 1 }, { b: 2 }], 'partials were not overwritten');
  });

  await testAsync('a write that lost the step after claiming is dropped (lease expired, another finished)', async () => {
    const store = memoryJobStore([seed()]);
    const r = await guardedStep(store, 'u1', 'j1', async () => {
      // Another request finished step 1 while this one was working.
      store.jobs.get('j1')!.step = 2;
      store.jobs.get('j1')!.message = 'theirs';
      return advanceTo(2, 'mine');
    }, described);
    assert.equal(r.stale, true);
    assert.equal(store.jobs.get('j1')!.message, 'theirs');
  });

  await testAsync('sequential steps each run once, and the lease never leaks into results', async () => {
    const store = memoryJobStore([seed()]);
    const r1 = await guardedStep(store, 'u1', 'j1', async () => advanceTo(2, 's2'), described);
    const r2 = await guardedStep(store, 'u1', 'j1', async () => advanceTo(3, 's3'), described);
    assert.deepEqual([r1.step, r2.step, r1.stale, r2.stale], [2, 3, undefined, undefined]);
    assert.equal(store.jobs.get('j1')!.error, null, 'advance clears the lease');
  });

  await testAsync('a live lease hides from callers; an expired one is reclaimable', async () => {
    let now = 1_000_000;
    const store = memoryJobStore([seed()]);
    assert.equal(await store.claim('u1', 'j1', 1, now), true);
    assert.equal(visibleError(store.jobs.get('j1')!), undefined);
    assert.equal(jobResult(store.jobs.get('j1')!).error, undefined);
    assert.equal(await store.claim('u1', 'j1', 1, now + 1_000), false, 'held');
    assert.equal(leaseLive(store.jobs.get('j1')!.error, now + 1_000), true);
    now += 60_000;
    assert.equal(await store.claim('u1', 'j1', 1, now), true, 'expired lease can be taken');
  });

  await testAsync('wrong step, wrong user, finished job: nothing is claimed or run', async () => {
    const store = memoryJobStore([seed(), seed({ id: 'j2', status: 'done', step: 4 })]);
    assert.equal(await store.claim('u1', 'j1', 2, 0), false);
    assert.equal(await store.claim('other', 'j1', 1, 0), false);
    let ran = false;
    const r = await guardedStep(store, 'u1', 'j2', async () => ((ran = true), advanceTo(5, 'x')), described);
    assert.equal(ran, false);
    assert.equal(r.done, true);
    await assert.rejects(guardedStep(store, 'other', 'j1', async () => advanceTo(2, 'x'), described), /not found/);
  });

  await testAsync('a failing step marks the job failed once, and a stale failure cannot kill a moved job', async () => {
    const store = memoryJobStore([seed()]);
    const r = await guardedStep(store, 'u1', 'j1', async () => { throw new Error('boom'); }, described);
    assert.equal(r.status, 'error');
    assert.equal(store.jobs.get('j1')!.status, 'error');
    assert.equal(store.jobs.get('j1')!.error, 'boom');

    const store2 = memoryJobStore([seed()]);
    const r2 = await guardedStep(store2, 'u1', 'j1', async () => {
      store2.jobs.get('j1')!.step = 2; // someone else advanced
      throw new Error('late');
    }, described);
    assert.equal(r2.stale, true);
    assert.equal(store2.jobs.get('j1')!.status, 'running');
  });
});
