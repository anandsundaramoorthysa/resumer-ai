/** SerpApi client with a stubbed fetch and an in-memory cache: no network, no database. */

import { assert, suiteAsync, testAsync } from './harness.mjs';
import { creditStatus, searchJobs, companyIntel } from '@/lib/serp/client';
import { cacheKey, creditsAllowed, memoryStore, resetSerpDeps, runAllowed, scrub, setSerpDeps } from '@/lib/serp/budget';
import { readFileSync } from 'node:fs';

const KEY = 'sekrit-key-123';
const jobsJson = JSON.parse(readFileSync('fixtures/serpapi/jobs-fullstack-bengaluru.json', 'utf8'));
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(env: Record<string, string | undefined>, handler: (url: URL) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const store = memoryStore();
  setSerpDeps({
    store,
    env: () => env,
    fetch: (async (input: unknown) => {
      const u = new URL(String(input));
      urls.push(u);
      return handler(u);
    }) as typeof fetch,
  });
  const searches = () => urls.filter((u) => u.pathname === '/search.json');
  return { urls, store, searches };
}

const accountOk = (u: URL, left = 200) => (u.pathname === '/account.json' ? ok({ total_searches_left: left }) : null);

await suiteAsync('searchJobs', async () => {
  await testAsync('sends gl=in, hl=en, google_domain and the restrictor; returns postings', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => accountOk(u) ?? ok(jobsJson));
    const r = await searchJobs('full stack developer Bengaluru', { userId: 'u1' });
    assert.ok(r.ok);
    assert.equal(r.mode, 'live');
    assert.equal(r.cached, false);
    assert.equal(r.credits, 1);
    assert.equal(r.data.length, 4);
    const p = s.searches()[0].searchParams;
    assert.equal(p.get('engine'), 'google_jobs');
    assert.equal(p.get('gl'), 'in');
    assert.equal(p.get('hl'), 'en');
    assert.equal(p.get('google_domain'), 'google.co.in');
    assert.ok(p.get('json_restrictor')?.includes('jobs_results'));
    assert.equal(p.get('no_cache'), null);
  });

  await testAsync('second identical call is a cache hit with one fetch total', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => accountOk(u) ?? ok(jobsJson));
    await searchJobs('x developer Pune', { userId: 'u1' });
    const again = await searchJobs('x developer Pune', { userId: 'u1' });
    assert.ok(again.ok && again.cached && again.credits === 0);
    assert.equal(s.searches().length, 1);
  });

  await testAsync('refresh bypasses the cache and sends no_cache', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => accountOk(u) ?? ok(jobsJson));
    await searchJobs('y developer', { userId: 'u1' });
    await searchJobs('y developer', { userId: 'u1', refresh: true });
    assert.equal(s.searches().length, 2);
    assert.equal(s.searches()[1].searchParams.get('no_cache'), 'true');
  });

  await testAsync('expired cache entry is refetched', async () => {
    const now = 1_000_000_000_000;
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => accountOk(u) ?? ok(jobsJson));
    setSerpDeps({ now: () => now });
    await searchJobs('z developer', { userId: 'u1' });
    for (const row of s.store.rows.values()) row.fetchedAt = new Date(now - 2 * 3_600_000);
    await searchJobs('z developer', { userId: 'u1' });
    assert.equal(s.searches().length, 2);
  });

  await testAsync('missing key => replay from fixtures, zero fetches', async () => {
    const s = setup({}, () => ok({}));
    const r = await searchJobs('data analyst Chennai', { userId: 'u1' });
    assert.ok(r.ok);
    assert.equal(r.mode, 'replay');
    assert.equal(r.credits, 0);
    assert.ok(r.data.some((j) => j.company === 'Demo Analytics'));
    assert.ok(r.data.every((j) => j.via === 'Sample data'));
    assert.equal(s.urls.length, 0);
  });

  await testAsync('SERP_MODE=replay wins over a key', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY, SERP_MODE: 'replay' }, () => ok({}));
    const r = await searchJobs('ml engineer Hyderabad', { userId: 'u1' });
    assert.ok(r.ok && r.mode === 'replay');
    assert.equal(s.urls.length, 0);
  });

  await testAsync('budget block (few credits left) => replay, no search fetch', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => accountOk(u, 5) ?? ok(jobsJson));
    const r = await searchJobs('q developer', { userId: 'u1' });
    assert.ok(r.ok && r.mode === 'replay');
    assert.equal(s.searches().length, 0);
    assert.equal((await creditStatus()).mode, 'replay');
  });

  await testAsync('budget block (45 searches this hour) => replay', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => accountOk(u) ?? ok(jobsJson));
    for (let i = 0; i < 45; i++) await s.store.put(`k${i}`, 'attempt', {});
    const r = await searchJobs('fresh developer', { userId: 'u1' });
    assert.ok(r.ok && r.mode === 'replay');
    assert.equal(s.searches().length, 0);
  });

  await testAsync('account.json is memoized', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => accountOk(u) ?? ok(jobsJson));
    await searchJobs('a1 developer', { userId: 'u1' });
    await searchJobs('a2 developer', { userId: 'u1' });
    assert.equal(s.urls.filter((u) => u.pathname === '/account.json').length, 1);
  });

  await testAsync('errors never contain the api key or a URL', async () => {
    setup({ SERPAPI_API_KEY: KEY }, (u) => {
      if (u.pathname === '/account.json') return ok({ total_searches_left: 100 });
      return ok({ error: `Invalid request https://serpapi.com/search.json?api_key=${KEY}&q=x` }, 400);
    });
    const r = await searchJobs('bad developer', { userId: 'u1' });
    assert.ok(!r.ok);
    assert.ok(!r.message.includes(KEY));
    assert.ok(!r.message.includes('api_key=' + KEY));
  });

  await testAsync('thrown fetch errors are generic', async () => {
    setup({ SERPAPI_API_KEY: KEY }, (u) => {
      if (u.pathname === '/account.json') return ok({ total_searches_left: 100 });
      throw new Error(`connect ECONNREFUSED ${u.toString()}`);
    });
    const r = await searchJobs('boom developer', { userId: 'u1' });
    assert.ok(!r.ok && r.reason === 'failed');
    assert.ok(!r.message.includes(KEY) && !r.message.includes('serpapi.com'));
  });

  await testAsync('429 maps to rate; timeout aborts', async () => {
    setup({ SERPAPI_API_KEY: KEY }, (u) => (u.pathname === '/account.json' ? ok({ total_searches_left: 100 }) : ok({}, 429)));
    const r = await searchJobs('rl developer', { userId: 'u1' });
    assert.ok(!r.ok && r.reason === 'rate');

    setup({ SERPAPI_API_KEY: KEY }, () => new Response('{}'));
    setSerpDeps({
      searchTimeoutMs: () => 20,
      fetch: ((_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))) as typeof fetch,
    });
    const t = await searchJobs('slow developer', { userId: 'u1' });
    assert.ok(!t.ok && /too long/.test(t.message));
  });
});

await suiteAsync('budget and errors', async () => {
  await testAsync('failed and timed-out attempts count towards the hour', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => accountOk(u) ?? ok({ error: 'boom' }, 500));
    for (let i = 0; i < 45; i++) await searchJobs(`fail ${i} developer`, { userId: 'u1' });
    const r = await searchJobs('one more developer', { userId: 'u1' });
    assert.ok(r.ok && r.mode === 'replay');
    assert.equal(s.searches().length, 45);
  });

  await testAsync('a DB error on the hour count fails closed as UNAVAILABLE, never as sample data', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => accountOk(u) ?? ok(jobsJson));
    s.store.countSince = async () => {
      throw new Error('db down');
    };
    const r = await searchJobs('closed developer', { userId: 'u1' });
    assert.ok(!r.ok && r.reason === 'unavailable');
    assert.match(r.message, /temporarily unavailable/);
    assert.equal(s.searches().length, 0);
    const c = await creditStatus();
    assert.ok(c.unavailable && c.mode === 'replay');
    // Without a key there is nothing to be unavailable: replay stays honest sample data.
    setup({}, () => ok({}));
    assert.equal((await creditStatus()).unavailable, false);
  });

  await testAsync('out-of-credits 429 is budget, a bare 429 is rate', async () => {
    setup({ SERPAPI_API_KEY: KEY }, (u) =>
      accountOk(u) ?? ok({ error: 'Your account has run out of searches.' }, 429),
    );
    const r = await searchJobs('credit developer', { userId: 'u1' });
    assert.ok(!r.ok && r.reason === 'budget');
  });

  await testAsync('empty results are billed 1 credit (verified live 2026-10-08) and are cached briefly', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) =>
      accountOk(u) ?? ok({ error: "Google hasn't returned any results for this query." }),
    );
    const r = await searchJobs('nothing developer', { userId: 'u1' });
    assert.ok(r.ok && r.credits === 1 && r.data.length === 0);
    const again = await searchJobs('nothing developer', { userId: 'u1' });
    assert.ok(again.ok && again.cached);
    assert.equal(s.searches().length, 1);
    const now = Date.now() + 11 * 60_000;
    setSerpDeps({ now: () => now });
    await searchJobs('nothing developer', { userId: 'u1' });
    assert.equal(s.searches().length, 2);
  });
});

await suiteAsync('companyIntel and helpers', async () => {
  await testAsync('replay intel merges rating and headlines', async () => {
    setup({}, () => ok({}));
    const r = await companyIntel('Sample Systems', 'job123', 'u1');
    assert.ok(r.ok && r.mode === 'replay');
    assert.equal(r.data.rating, 4.2);
    assert.equal(r.data.headlines.length, 2);
  });

  await testAsync('live news never sends `so` (SerpApi 400s q+so); documented ratings[] parse', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => {
      const a = accountOk(u);
      if (a) return a;
      if (u.searchParams.get('engine') === 'google_news') {
        return u.searchParams.has('so')
          ? ok({ error: '`q` and `so` parameters can\'t be used together.' }, 400)
          : ok({ news_results: [{ title: 'Acme raises funds', link: 'https://example.com/a', source: { name: 'Example' }, date: '1 day ago' }] });
      }
      return ok({ ratings: [{ company_name: 'Acme', link: 'https://example.com/r', source: 'Indeed', rating: 3.9, reviews: 1200 }] });
    });
    const r = await companyIntel('Acme', 'jobid-b64', 'u1');
    assert.ok(r.ok);
    assert.equal(r.data.headlines.length, 1);
    assert.equal(r.data.rating, 3.9);
    assert.equal(r.data.ratingSource, 'Indeed');
    assert.ok(s.searches().every((u) => !u.searchParams.has('so')));
  });

  await testAsync('empty listing falls back to a Google review-site rating; news query is quoted', async () => {
    const s = setup({ SERPAPI_API_KEY: KEY }, (u) => {
      const a = accountOk(u);
      if (a) return a;
      const e = u.searchParams.get('engine');
      if (e === 'google_jobs_listing') return ok({ search_information: { jobs_listing_state: 'Fully empty' }, error: "Google hasn't returned any results for this query." }, 200);
      if (e === 'google') {
        return ok({ organic_results: [{ source: 'glassdoor.co.in', title: 'Acme Reviews - Glassdoor', link: 'https://www.glassdoor.co.in/x', rich_snippet: { top: { detected_extensions: { rating: 3.6, reviews: 3961 } } } }] });
      }
      return ok({ news_results: [{ title: 'Acme expands', link: 'https://example.com/a', source: 'Ex', date: 'd' }, { title: 'Unrelated', link: 'https://example.com/b', source: 'Ex', date: 'd' }] });
    });
    const r = await companyIntel('Acme', 'jid', 'u1');
    assert.ok(r.ok);
    assert.equal(r.data.rating, 3.6);
    assert.equal(r.data.ratingSource, 'Glassdoor (via Google)');
    assert.equal(r.data.headlines.length, 1);
    assert.equal(r.credits, 3); // empty listing + news + google, each billed
    assert.ok(s.searches().some((u) => u.searchParams.get('q') === '"Acme" company India'));
  });

  await testAsync('every single SerpApi http call is bounded at 8s (a 40s call outlived the host and was billed in a loop)', async () => {
    resetSerpDeps();
    const { deps } = await import('@/lib/serp/budget');
    for (const e of ['google_jobs', 'google_news', 'google', 'google_jobs_listing']) {
      assert.ok(deps.searchTimeoutMs(e) <= 8_000, e);
    }
    assert.ok(deps.timeoutMs <= 8_000, 'account.json');
  });

  await testAsync('cache keys ignore api_key and param order', async () => {
    assert.equal(cacheKey('e', { a: '1', b: '2', api_key: 'x' }), cacheKey('e', { b: '2', a: '1' }));
    assert.notEqual(cacheKey('e', { a: '1' }), cacheKey('f', { a: '1' }));
  });

  await testAsync('scrub strips the key and api_key= params', async () => {
    setup({ SERPAPI_API_KEY: KEY }, () => ok({}));
    assert.ok(!scrub(`x api_key=${KEY}&q=1 and ${KEY}`).includes(KEY));
  });

  await testAsync('per-user run limits', async () => {
    assert.ok(runAllowed(2) && !runAllowed(3));
    assert.ok(creditsAllowed(11) && !creditsAllowed(12));
  });
});

resetSerpDeps();
