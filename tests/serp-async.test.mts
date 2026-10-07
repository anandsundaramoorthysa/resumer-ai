/** SerpApi async submit/poll, single-flight and credit-guard states, with a stubbed fetch and memory cache. */

import { assert, suiteAsync, testAsync } from './harness.mjs';
import { companyIntel, pollSearchJobs, submitSearchJobs, searchJobs } from '@/lib/serp/client';
import { creditStatus, memoryStore, resetSerpDeps, setSerpDeps } from '@/lib/serp/budget';
import { readFileSync } from 'node:fs';

const KEY = 'sekrit-key-123';
const jobsJson = JSON.parse(readFileSync('fixtures/serpapi/jobs-fullstack-bengaluru.json', 'utf8'));
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(handler: (u: URL) => Response | Promise<Response>, env: Record<string, string | undefined> = { SERPAPI_API_KEY: KEY }) {
  resetSerpDeps();
  const urls: URL[] = [];
  const store = memoryStore();
  setSerpDeps({
    store,
    env: () => env,
    sleep: async (ms) => void (await delay(Math.min(ms, 5))),
    fetch: (async (input: unknown) => {
      const u = new URL(String(input));
      urls.push(u);
      return handler(u);
    }) as typeof fetch,
  });
  return {
    urls,
    store,
    submits: () => urls.filter((u) => u.pathname === '/search.json'),
    polls: () => urls.filter((u) => u.pathname.startsWith('/searches/')),
    accounts: () => urls.filter((u) => u.pathname === '/account.json'),
  };
}
const account = (u: URL) => (u.pathname === '/account.json' ? ok({ total_searches_left: 200 }) : null);
const processing = (id: string) => ok({ search_metadata: { id, status: 'Processing' } });
// The archive echoes the search it holds: the id, and the query when the restrictor keeps search_parameters.
const success = (id: string, q = 'node developer Pune') =>
  ok({ ...jobsJson, search_parameters: { q }, search_metadata: { id, status: 'Success' } });

await suiteAsync('async submit and poll', async () => {
  await testAsync('submit sends async=true, never no_cache, returns the search id at once', async () => {
    const s = setup((u) => account(u) ?? processing('abc123def'));
    const reserved: string[] = [];
    const o = await submitSearchJobs('react developer Pune', {
      userId: 'u1',
      reserve: async () => (reserved.push('r'), true),
      stored: async (id) => void reserved.push(id),
    });
    assert.ok(o.kind === 'pending' && o.searchId === 'abc123def' && !o.shared);
    assert.deepEqual(reserved, ['r', 'abc123def'], 'reserve before the call, id stored right after');
    const p = s.submits()[0].searchParams;
    assert.equal(p.get('async'), 'true');
    assert.equal(p.get('no_cache'), null);
    assert.equal(p.get('engine'), 'google_jobs');
  });

  await testAsync('poll: Processing stays pending; Success parses, caches, and a later search is a cache hit', async () => {
    let state: 'processing' | 'success' = 'processing';
    const s = setup((u) => account(u) ?? (u.pathname.startsWith('/searches/') ? (state === 'processing' ? processing('sid-000001') : success('sid-000001')) : processing('sid-000001')));
    const sub = await submitSearchJobs('node developer Pune', { userId: 'u1' });
    assert.ok(sub.kind === 'pending');
    assert.equal((await pollSearchJobs('node developer Pune', { searchId: 'sid-000001' })).kind, 'pending');
    state = 'success';
    const done = await pollSearchJobs('node developer Pune', { searchId: 'sid-000001' });
    assert.ok(done.kind === 'result' && done.result.ok && done.result.data.length === 4 && done.result.mode === 'live');
    assert.match(s.polls()[0].pathname, /^\/searches\/sid-000001\.json$/);
    const again = await submitSearchJobs('node developer Pune', { userId: 'u1' });
    assert.ok(again.kind === 'result' && again.result.ok && again.result.cached, 'cached by the normalized key');
    assert.equal(s.submits().length, 1);
    // A second poller (another run, or a retried step) is served from the cache: no archive read.
    const before = s.polls().length;
    const third = await pollSearchJobs('node developer Pune', { searchId: 'sid-000001' });
    assert.ok(third.kind === 'result' && s.polls().length === before);
  });

  await testAsync('poll: Error status is a definitive, refundable failure; 5xx and timeouts stay pending', async () => {
    let mode: 'error' | '500' | 'hang' = 'error';
    setup((u) => {
      if (u.pathname === '/account.json') return ok({ total_searches_left: 200 });
      if (!u.pathname.startsWith('/searches/')) return processing('sid-000002');
      if (mode === '500') return ok({}, 503);
      return ok({ search_metadata: { id: 'sid-000002', status: 'Error' }, error: `bad api_key=${KEY}` });
    });
    const e = await pollSearchJobs('err developer', { searchId: 'sid-000002' });
    assert.ok(e.kind === 'result' && !e.result.ok && e.result.refund === true);
    assert.ok(!JSON.stringify(e).includes(KEY));
    mode = '500';
    assert.equal((await pollSearchJobs('err2 developer', { searchId: 'sid-000002' })).kind, 'pending');
    mode = 'hang';
    setSerpDeps({
      searchTimeoutMs: () => 15,
      fetch: ((_u: unknown, init?: RequestInit) =>
        new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))) as typeof fetch,
    });
    assert.equal((await pollSearchJobs('hang developer', { searchId: 'sid-000002' })).kind, 'pending');
  });

  await testAsync('poll: an archive answer for ANOTHER search (id or query) is refused and never cached', async () => {
    const s = setup((u) => (u.pathname.startsWith('/searches/') ? success('some-other-id', 'node developer Pune') : ok({})));
    const a = await pollSearchJobs('node developer Pune', { searchId: 'sid-000009' });
    assert.ok(a.kind === 'result' && !a.result.ok && /different search/.test(a.result.message));
    setup((u) => (u.pathname.startsWith('/searches/') ? success('sid-000009', 'completely other query') : ok({})));
    const b = await pollSearchJobs('node developer Pune', { searchId: 'sid-000009' });
    assert.ok(b.kind === 'result' && !b.result.ok);
    assert.equal(s.store.rows.size, 0, 'nothing cached under the wrong key');
    setup(() => success('sid-000009', 'Node Developer Pune '));
    const c = await pollSearchJobs('node developer Pune', { searchId: 'sid-000009' });
    assert.ok(c.kind === 'result' && c.result.ok, 'case and spacing of the echoed query do not matter');
  });

  await testAsync('a response whose BODY never finishes is cut at the cap (headers arrived, body stalled)', async () => {
    setup((u) => {
      if (u.pathname === '/account.json') return ok({ total_searches_left: 200 });
      const body = new ReadableStream({ start: (c) => void c.enqueue(new TextEncoder().encode('{"search_metad')) });
      return new Response(body, { status: 200 });
    });
    setSerpDeps({ searchTimeoutMs: () => 80 });
    const t0 = Date.now();
    const sub = await submitSearchJobs('stalled body developer', { userId: 'u1', reserve: async () => true });
    assert.ok(sub.kind === 'result' && !sub.result.ok && /too long/.test(sub.result.message));
    assert.ok(Date.now() - t0 < 1_000, 'returned at the cap, not hung');
    const t1 = Date.now();
    assert.equal((await pollSearchJobs('stalled poll developer', { searchId: 'sid-000010' })).kind, 'pending');
    assert.ok(Date.now() - t1 < 1_000);
    // account.json too
    setup(async (u) => (u.pathname === '/account.json' ? new Response(new ReadableStream({ start: (c) => void c.enqueue(new Uint8Array([123])) })) : ok({})));
    setSerpDeps({ timeoutMs: 80 });
    const t2 = Date.now();
    assert.equal((await creditStatus()).left, -1, 'fails open');
    assert.ok(Date.now() - t2 < 1_000);
  });

  await testAsync('submit: a JSON error answer is refundable; a thrown/timeout is not (it may have been accepted)', async () => {
    setup((u) => account(u) ?? ok({ error: 'Invalid request' }, 400));
    const a = await submitSearchJobs('bad developer', { userId: 'u1' });
    assert.ok(a.kind === 'result' && !a.result.ok && a.result.refund === true);
    setup((u) => {
      if (u.pathname === '/account.json') return ok({ total_searches_left: 200 });
      throw new Error(`ECONNRESET ${u.toString()}`);
    });
    const b = await submitSearchJobs('reset developer', { userId: 'u1' });
    assert.ok(b.kind === 'result' && !b.result.ok && b.result.refund !== true);
    assert.ok(!JSON.stringify(b).includes(KEY) && !JSON.stringify(b).includes('serpapi.com'));
  });

  await testAsync('submit: reserve() refusing (credit cap) sends nothing and frees the single-flight slot', async () => {
    const s = setup((u) => account(u) ?? processing('sid-000003'));
    const o = await submitSearchJobs('capped developer', { userId: 'u1', reserve: async () => false });
    assert.equal(o.kind, 'declined');
    assert.equal(s.submits().length, 0);
    assert.equal([...s.store.rows.keys()].filter((k) => k.startsWith('inflight:')).length, 0);
  });

  await testAsync('no key => replay result at submit (nothing to poll), zero fetches', async () => {
    const s = setup(() => ok({}), {});
    const o = await submitSearchJobs('data analyst Chennai', { userId: 'u1' });
    assert.ok(o.kind === 'result' && o.result.ok && o.result.mode === 'replay');
    assert.equal(s.urls.length, 0);
  });
});

await suiteAsync('single-flight', async () => {
  await testAsync('identical concurrent submits make ONE search; the loser shares its id', async () => {
    const s = setup(async (u) => {
      if (u.pathname === '/account.json') return ok({ total_searches_left: 200 });
      await delay(15);
      return processing('sid-shared01');
    });
    const calls: string[] = [];
    const mk = (n: string) =>
      submitSearchJobs('same developer', { userId: n, reserve: async () => (calls.push(n), true) });
    const [a, b, c] = await Promise.all([mk('u1'), mk('u2'), mk('u3')]);
    assert.equal(s.submits().length, 1, 'one billable search for three identical callers');
    assert.equal(calls.length, 1, 'only the winner reserves credits');
    for (const o of [a, b, c]) assert.ok(o.kind === 'pending' && o.searchId === 'sid-shared01');
    assert.equal([a, b, c].filter((o) => o.kind === 'pending' && o.shared).length, 2);
  });

  await testAsync('a losing waiter keeps waiting (up to ~6s) and then follows the winner\'s id instead of skipping', async () => {
    const s = setup(async (u) => {
      if (u.pathname === '/account.json') return ok({ total_searches_left: 200 });
      await delay(60); // the winner's submit is slow: longer than the OLD 3s wait would be at 5ms sleeps x6
      return processing('sid-slowwin01');
    });
    // 5ms sleeps: the old 3s wait = 6 loops = 30ms < 60ms (loser would have given up); 6s wait = 12 loops = 60ms+
    setSerpDeps({ sleep: async () => void (await delay(8)) });
    const [a, b] = await Promise.all([1, 2].map(() => submitSearchJobs('slow winner developer', { userId: 'u' })));
    assert.equal(s.submits().length, 1);
    assert.ok(a.kind === 'pending' && b.kind === 'pending' && a.searchId === b.searchId);
  });

  await testAsync('a dead winner (stale inflight row) can be taken over', async () => {
    const s = setup((u) => account(u) ?? processing('sid-takeover1'));
    assert.equal(await s.store.claimInflight('inflight:x'), true);
    assert.equal(await s.store.claimInflight('inflight:x'), false);
    const row = s.store.rows.get('inflight:x')!;
    row.fetchedAt = new Date(Date.now() - 25_000);
    assert.equal(await s.store.claimInflight('inflight:x'), true, 'older than 20s without a search id');
    await s.store.put('inflight:x', 'inflight', { searchId: 'z' });
    s.store.rows.get('inflight:x')!.fetchedAt = new Date(Date.now() - 25_000);
    assert.equal(await s.store.claimInflight('inflight:x'), false, 'a stored id keeps it for minutes');
  });

  await testAsync('sync searches single-flight too: parallel identical calls, one fetch', async () => {
    const s = setup(async (u) => {
      if (u.pathname === '/account.json') return ok({ total_searches_left: 200 });
      await delay(15);
      return ok(jobsJson);
    });
    const rs = await Promise.all([1, 2, 3].map(() => searchJobs('sync same developer', { userId: 'u1' })));
    assert.equal(s.submits().length, 1);
    assert.ok(rs.every((r) => r.ok), 'losers are answered from the winner\'s cache entry');
  });

  await testAsync('account.json does not stampede: parallel cold lookups make ONE request', async () => {
    const s = setup(async (u) => {
      if (u.pathname === '/account.json') {
        await delay(12);
        return ok({ total_searches_left: 150 });
      }
      return ok({});
    });
    const rs = await Promise.all(Array.from({ length: 8 }, () => creditStatus()));
    assert.equal(s.accounts().length, 1);
    assert.ok(rs.every((r) => r.left === 150));
  });
});

await suiteAsync('intel step bound', async () => {
  await testAsync('listing, news and the rating search run IN PARALLEL (step = one 8s call, not two in sequence)', async () => {
    let inflight = 0;
    let peak = 0;
    setup(async (u) => {
      if (u.pathname === '/account.json') return ok({ total_searches_left: 200 });
      inflight++;
      peak = Math.max(peak, inflight);
      await delay(20);
      inflight--;
      const e = u.searchParams.get('engine');
      if (e === 'google') return ok({ organic_results: [{ source: 'glassdoor.co.in', title: 'Acme Reviews - Glassdoor', link: 'https://www.glassdoor.co.in/x', rich_snippet: { top: { detected_extensions: { rating: 3.6, reviews: 10 } } } }] });
      if (e === 'google_news') return ok({ news_results: [] });
      return ok({ error: "Google hasn't returned any results for this query." });
    });
    const r = await companyIntel('Acme', 'jid-123456', 'u1');
    assert.equal(peak, 3);
    assert.ok(r.ok && r.data.rating === 3.6);
  });
});

resetSerpDeps();
