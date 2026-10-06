/** Radar HTTP handlers with injected auth, approval and an in-memory run store. */

import { assert, suiteAsync, testAsync } from './harness.mjs';
import { makeRadarHandlers } from '@/lib/radar/handlers';
import { advanceRadar, approveQueries, cancelRadar, getRadar, memoryRunStore, selectPosting, startRadar } from '@/lib/radar/runs';
import type { RadarDeps } from '@/lib/radar/runs';

function setup() {
  const state = { user: 'u1' as string | null, approval: 'approved', credits: 0, missing: false };
  const store = memoryRunStore();
  const d = { store, now: () => Date.now() } as unknown as RadarDeps;
  const h = makeRadarHandlers({
    userId: async () => state.user,
    approval: async () => state.approval,
    assertBurst: async () => {},
    credits: async () => {
      state.credits += 1;
      return { left: 90, hourUsed: 1, mode: 'live' };
    },
    extraHosts: ['app.example.com'],
    start: async (u, o) => {
      if (state.missing) throw Object.assign(new Error('Failed query: select ...'), { cause: { code: '42P01' } });
      return startRadar(u, o, d);
    },
    advance: (u, id, s) => advanceRadar(u, id, s, d),
    approve: (u, id, q) => approveQueries(u, id, q, d),
    select: (u, id, k) => selectPosting(u, id, k, d),
    cancel: (u, id) => cancelRadar(u, id, d),
    get: (u, id) => getRadar(u, id, d),
  });
  const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
    h.POST(
      new Request('https://app.example.com/api/radar', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'app.example.com', ...headers },
        body: raw ?? JSON.stringify(body),
      }),
    );
  const get = (qs = '') => h.GET(new Request(`https://app.example.com/api/radar${qs}`));
  return { state, store, post, get };
}

await suiteAsync('radar route handlers', async () => {
  await testAsync('401 when signed out, on GET and POST', async () => {
    const t = setup();
    t.state.user = null;
    assert.equal((await t.get()).status, 401);
    assert.equal((await t.post({})).status, 401);
  });

  await testAsync('403 for an unapproved account, credits included, and nothing is read', async () => {
    const t = setup();
    t.state.approval = 'pending';
    const g = await t.get('?credits=1');
    assert.equal(g.status, 403);
    assert.deepEqual(await g.json(), { error: 'Your account is waiting for approval.' });
    assert.equal(t.state.credits, 0, 'no credit lookup for an unapproved user');
    assert.equal((await t.get()).status, 403);
    assert.equal((await t.post({})).status, 403);
    assert.equal(t.store.runs.length, 0);
    t.state.approval = 'denied';
    assert.equal((await t.post({})).status, 403);
  });

  await testAsync('approved account: credits, start, resume', async () => {
    const t = setup();
    assert.equal((await (await t.get('?credits=1')).json()).left, 90);
    const started = await (await t.post({ intel: false })).json();
    assert.equal(started.phase, 'plan');
    assert.equal((await (await t.get()).json()).run.runId, started.runId);
  });

  await testAsync('415 without a JSON content type', async () => {
    const t = setup();
    assert.equal((await t.post({}, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await t.post({}, { 'content-type': '' })).status, 415);
    assert.equal(t.store.runs.length, 0);
  });

  await testAsync('413 for a body over 8 KB', async () => {
    const t = setup();
    const res = await t.post({ intel: true, pad: 'x'.repeat(9_000) });
    assert.equal(res.status, 413);
    assert.equal(t.store.runs.length, 0);
  });

  await testAsync('403 for a cross-origin POST; same host, forwarded host and AUTH_URL host pass', async () => {
    const t = setup();
    assert.equal((await t.post({}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.post({}, { origin: 'not a url' })).status, 403);
    assert.equal(t.store.runs.length, 0);
    assert.equal((await t.post({}, { origin: 'https://app.example.com' })).status, 200);
    await cancelRadar('u1', t.store.runs[0].id, { store: t.store, now: Date.now } as unknown as RadarDeps);
    assert.equal((await t.post({}, { origin: 'https://other.test', 'x-forwarded-host': 'other.test' })).status, 200);
    assert.equal((await t.post({}, { origin: 'https://app.example.com', host: 'internal:3000' })).status, 200);
  });

  await testAsync('400 for a body that is not strictly one of the known shapes', async () => {
    const t = setup();
    assert.equal((await t.post({ intel: true, extra: 1 })).status, 400);
    assert.equal((await t.post({ runId: 'a/b', expectStep: 0 })).status, 400);
    assert.equal((await t.post({ runId: 'r1', expectStep: -1 })).status, 400);
    assert.equal((await t.post({ runId: 'r1', action: 'approve', queries: [] })).status, 400);
    assert.equal((await t.post(null, {}, '{not json')).status, 400);
    assert.equal((await t.get('?runId=bad%20id')).status, 400);
    assert.equal(t.store.runs.length, 0);
  });

  await testAsync('503 with the setup hint when the tables are missing', async () => {
    const t = setup();
    t.state.missing = true;
    const res = await t.post({});
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /db:push/);
    assert.match(body.error, /2026-10-06-job-radar\.sql/);
    assert.ok(!/select/i.test(body.error));
  });

  await testAsync('404 for another user\'s run, on GET and POST', async () => {
    const t = setup();
    const mine = await (await t.post({})).json();
    t.state.user = 'u2';
    assert.equal((await t.get(`?runId=${mine.runId}`)).status, 404);
    assert.equal((await t.post({ runId: mine.runId, expectStep: 0 })).status, 404);
    assert.equal((await t.post({ runId: mine.runId, action: 'cancel' })).status, 404);
    t.state.user = 'u1';
    assert.equal((await t.get(`?runId=${mine.runId}`)).status, 200);
  });
});
