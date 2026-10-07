/**
 * SerpApi over plain fetch. One call = one credit; identical params are served from
 * `serp_cache` (1h jobs, 24h news/listing). Never logs or returns a URL: the key rides in
 * the query string, so every message is generic and passed through `scrub`.
 *
 * Two ways to search:
 *  - ASYNC (production, google_jobs): `submitSearchJobs` sends async=true and returns at once
 *    with a search id; `pollSearchJobs` reads it from the Search Archive in a LATER request.
 *    Every individual http call is <= 8s, so a serverless step can never be killed mid-call
 *    and re-billed. An async submit and the archive reads are free; the search is billed 1 credit once it
 *    completes (verified live on 2026-10-08).
 *  - SYNC (`searchJobs`, `companyIntel`, replay mode, tests/scripts): one blocking call, also
 *    hard-bounded at 8s (deps.searchTimeoutMs).
 *
 * Replay mode (no key, SERP_MODE=replay, or the credit guard blocking) answers from
 * fixtures/serpapi and labels the result mode:'replay'. If the guard's own storage is down
 * the answer is `unavailable`, never fixtures.
 *
 * Single-flight: identical concurrent searches share one upstream search through an
 * 'inflight' row in serp_cache (INSERT ... ON CONFLICT), see CacheStore.claimInflight.
 */

import { budgetState, cacheKey, deps, fetchJson, noteAttempt, scrub } from './budget';
import { loadFixture, recordFixture } from './fixtures';
import { dedupePostings, normalizeJobs, parseGoogleRating, parseListing, parseNews } from './normalize';
import type { EmployerIntel, Posting, SearchPoll, SearchSubmit, SerpResult } from './types';

export { creditStatus, scrub } from './budget';
export { dedupePostings } from './normalize';
export { parseSalaryLpa } from './salary';

const ENDPOINT = 'https://serpapi.com/search.json';
const ARCHIVE = 'https://serpapi.com/searches';
const HOUR = 3_600_000;
const TTL = { google_jobs: HOUR, google_news: 24 * HOUR, google_jobs_listing: 24 * HOUR, google: 24 * HOUR } as const;
const EMPTY_TTL = 10 * 60_000;
/** How long a caller that lost the single-flight race waits for the winner. */
const FLIGHT_WAIT_MS = 6_000; // long enough for the winner's submit (<= 8s) to usually publish its search id
type Engine = keyof typeof TTL;

const RESTRICTOR: Record<Engine, string> = {
  google_jobs:
    'jobs_results[].{job_id,title,company_name,location,via,description,detected_extensions,job_highlights,extensions,apply_options},serpapi_pagination,search_metadata,search_parameters,error',
  google_news: 'news_results[].{title,link,source,date,snippet},search_metadata,error',
  google: 'organic_results[].{title,link,source,displayed_link,rich_snippet},search_metadata,error',
  google_jobs_listing: '',
};

/** Top-level keys kept from an archive response (it may not honour json_restrictor). */
const KEEP: Record<Engine, string[]> = {
  google_jobs: ['jobs_results', 'error'],
  google_news: ['news_results', 'error'],
  google: ['organic_results', 'error'],
  google_jobs_listing: ['ratings', 'search_information', 'error'],
};

type Raw = { ok: true; json: unknown; cached: boolean; mode: 'live' | 'replay'; credits: number };
type Fail = Extract<SerpResult<never>, { ok: false }>;

const JOBS_PARAMS = (q: string) => ({ q, gl: 'in', hl: 'en', google_domain: 'google.co.in' });

const replayFor = (engine: Engine, q: string): Raw | Fail => {
  try {
    return { ok: true, json: loadFixture(engine, q), cached: false, mode: 'replay', credits: 0 };
  } catch {
    return { ok: false, reason: 'not-configured', message: 'No SerpApi key is set and no sample data is available.' };
  }
};

/**
 * Everything that happens before money can be spent: replay mode, fresh cache, credit guard.
 * `go` = proceed to spend; otherwise `done` is the answer.
 */
async function gate(
  engine: Engine,
  params: Record<string, string>,
  refresh: boolean,
): Promise<{ done: Raw | Fail } | { go: { ck: string; key: string } }> {
  const env = deps.env();
  const key = env.SERPAPI_API_KEY;
  const sm = env.SERP_MODE;
  const q = params.q ?? '';
  if (!key || sm === 'replay') return { done: replayFor(engine, q) };

  const ck = cacheKey(engine, params);
  if (!refresh && sm !== 'record') {
    const hit = await cacheHit(ck, engine);
    if (hit) return { done: hit };
  }
  const state = await budgetState();
  if (state === 'unavailable') {
    return { done: { ok: false, reason: 'unavailable', message: 'Search is temporarily unavailable.' } };
  }
  if (state === 'blocked') return { done: replayFor(engine, q) };
  return { go: { ck, key } };
}

async function cacheHit(ck: string, engine: Engine): Promise<Raw | null> {
  try {
    const hit = await deps.store.get(ck);
    const empty = (hit?.payload as { _empty?: unknown } | undefined)?._empty === true;
    if (hit && deps.now() - hit.fetchedAt.getTime() < (empty ? EMPTY_TTL : TTL[engine])) {
      return { ok: true, json: empty ? {} : hit.payload, cached: true, mode: 'live', credits: 0 };
    }
  } catch {
    // a cache that cannot be read is a miss, not a failure
  }
  return null;
}

const msgOf = (json: { error?: unknown } | null, status: number) =>
  scrub(typeof json?.error === 'string' ? json.error : `SerpApi answered ${status}.`);

/** Turn a finished SerpApi answer into a result, caching it. Shared by the sync and async paths. */
async function finish(
  engine: Engine,
  params: Record<string, string>,
  ck: string,
  status: number,
  json: ({ error?: unknown } & Record<string, unknown>) | null,
  keepKeys?: string[],
): Promise<Raw | Fail> {
  const q = params.q ?? '';
  if (status < 200 || status >= 300 || !json || json.error) {
    const msg = msgOf(json, status);
    // "hasn't returned any results" is an empty answer, not a failure, but it IS billed: verified live on
    // 2026-10-08 (status "Success" + that error text, account.json dropped by 1). Cached briefly so the same empty query is not paid for again.
    if (json && /hasn't returned any results/i.test(msg)) {
      try {
        await deps.store.put(ck, engine, { _empty: true });
      } catch {
        // caching is an optimisation
      }
      return { ok: true, json: {}, cached: false, mode: 'live', credits: 1 };
    }
    // Out-of-credits is often a 429 too: read the message before the status.
    const reason = /run out|out of (?:searches|credits)|searches left|plan/i.test(msg)
      ? 'budget'
      : status === 429
        ? 'rate'
        : 'failed';
    // A JSON error from SerpApi is a definitive "no": the credit was not billed.
    return { ok: false, reason, message: msg, ...(json ? { refund: true } : {}) };
  }
  const body = keepKeys ? Object.fromEntries(Object.entries(json).filter(([k]) => keepKeys.includes(k))) : json;
  if (deps.env().SERP_MODE === 'record') recordFixture(engine, q, body);
  try {
    await deps.store.put(ck, engine, body);
  } catch {
    // caching is an optimisation
  }
  // Always 1: SerpApi bills a fresh search one credit and serves its own server-side cache
  // free, but the response carries no documented, reliable marker for which one we got
  // (search_metadata.status is "Success" either way). Reported spend is therefore an upper bound.
  return { ok: true, json: body, cached: false, mode: 'live', credits: 1 };
}

/** One http GET bounded as a WHOLE (headers and body) by the engine's cap. */
const get = (url: string, engine: Engine) => fetchJson(url, deps.searchTimeoutMs(engine));

const thrown = (err: unknown): Fail => {
  const timedOut = err instanceof Error && err.name === 'AbortError';
  return {
    ok: false,
    reason: 'failed',
    message: timedOut ? 'SerpApi took too long.' : scrub('SerpApi could not be reached.'),
  };
};

/** Wait (bounded) for whoever won the single-flight race: their search id, or their cached result. */
async function waitForWinner(
  inflightKey: string,
  ck: string,
  engine: Engine,
): Promise<{ searchId: string } | { hit: Raw } | null> {
  for (let waited = 0; waited < FLIGHT_WAIT_MS; waited += 500) {
    await deps.sleep(500);
    const hit = await cacheHit(ck, engine);
    if (hit) return { hit };
    try {
      const row = await deps.store.get(inflightKey);
      const id = (row?.payload as { searchId?: unknown } | undefined)?.searchId;
      if (typeof id === 'string' && id) return { searchId: id };
    } catch {
      // keep waiting
    }
  }
  return null;
}

const busy: Fail = { ok: false, reason: 'rate', message: 'An identical search is already running. Try again shortly.' };

/** SYNC path: one blocking call (bounded at 8s), with single-flight and cache. */
async function call(
  engine: Engine,
  params: Record<string, string>,
  refresh: boolean,
): Promise<Raw | Fail> {
  const g = await gate(engine, params, refresh);
  if ('done' in g) return g.done;
  const { ck, key } = g.go;
  const flight = `inflight:${ck}`;

  let won = true;
  try {
    won = await deps.store.claimInflight(flight);
  } catch {
    // the guard storage hiccuped: proceed (the hourly counter still binds)
  }
  if (!won) {
    const w = await waitForWinner(flight, ck, engine);
    return w && 'hit' in w ? w.hit : busy;
  }

  const qs = new URLSearchParams({ ...params, engine, api_key: key });
  if (refresh) qs.set('no_cache', 'true');
  if (RESTRICTOR[engine]) qs.set('json_restrictor', RESTRICTOR[engine]);

  try {
    // Counted before the call: a failure or timeout may still have been billed. NO auto-retry anywhere.
    await noteAttempt();
    const res = await get(`${ENDPOINT}?${qs.toString()}`, engine);
    return await finish(engine, params, ck, res.status, res.json);
  } catch (err) {
    return thrown(err);
  } finally {
    await deps.store.releaseInflight(flight).catch(() => undefined);
  }
}

const done = <T>(r: Raw, data: T): SerpResult<T> => ({
  ok: true,
  data,
  cached: r.cached,
  mode: r.mode,
  credits: r.credits,
});

function jobsFrom(r: Raw, fromQuery: number): SerpResult<Posting[]> {
  let postings = dedupePostings(normalizeJobs(r.json, fromQuery));
  // Replay data is hand-written: label every posting so the UI can show SAMPLE.
  if (r.mode === 'replay') postings = postings.map((p) => ({ ...p, via: 'Sample data' }));
  return done(r, postings);
}

/** Page 1 of Google Jobs India, SYNCHRONOUS (<= 8s). Put the city in `q` ("react developer Bengaluru"). */
export async function searchJobs(
  q: string,
  opts: { userId: string; refresh?: boolean; fromQuery?: number } = { userId: '' },
): Promise<SerpResult<Posting[]>> {
  const r = await call('google_jobs', JOBS_PARAMS(q), !!opts.refresh);
  return r.ok ? jobsFrom(r, opts.fromQuery ?? 0) : r;
}

/* ------------------------------------------------------------------- async -- */

/**
 * ASYNC submit (docs: https://serpapi.com/search-api, `async=true`; no `no_cache` with it).
 * Verified live on 2026-10-08: the immediate answer (HTTP 200, ~0.3s) is `{search_metadata:{id,
 * status:'Processing',json_endpoint,...}}` with no other key; the archive then answers Success
 * after ~1s, honours json_restrictor, and re-reads are free. Returns at once: a cached/replay result, or a search id to poll later.
 *
 * `reserve()` runs after the cache and credit-guard checks and right before the http call; the
 * orchestrator uses it to persist the credit reservation and a "submitting" ledger row, so a
 * crash can never lead to a second submit. `stored(id)` runs the moment the id is known.
 */
export async function submitSearchJobs(
  q: string,
  opts: {
    userId: string;
    fromQuery?: number;
    reserve?: () => Promise<boolean>;
    stored?: (searchId: string) => Promise<void>;
  },
): Promise<SearchSubmit> {
  const params = JOBS_PARAMS(q);
  const from = opts.fromQuery ?? 0;
  const g = await gate('google_jobs', params, false);
  if ('done' in g) return { kind: 'result', result: g.done.ok ? jobsFrom(g.done, from) : g.done };
  const { ck, key } = g.go;
  const flight = `inflight:${ck}`;

  let won = true;
  try {
    won = await deps.store.claimInflight(flight);
  } catch {
    // proceed; the ledger and the hourly counter still bind
  }
  if (!won) {
    const w = await waitForWinner(flight, ck, 'google_jobs');
    if (w && 'hit' in w) return { kind: 'result', result: jobsFrom(w.hit, from) };
    if (w) return { kind: 'pending', searchId: w.searchId, shared: true };
    return { kind: 'result', result: busy };
  }

  const release = () => deps.store.releaseInflight(flight).catch(() => undefined);
  try {
    if (opts.reserve && !(await opts.reserve())) {
      await release();
      return { kind: 'declined' };
    }
    await noteAttempt();
    const qs = new URLSearchParams({ ...params, engine: 'google_jobs', api_key: key, async: 'true' });
    qs.set('json_restrictor', RESTRICTOR.google_jobs);
    const res = await get(`${ENDPOINT}?${qs.toString()}`, 'google_jobs');
    const json = res.json;
    const meta = (json?.search_metadata ?? {}) as { id?: unknown; status?: unknown };
    if (!res.ok || !json || json.error) {
      await release();
      const f = await finish('google_jobs', params, ck, res.status, json);
      return { kind: 'result', result: f.ok ? jobsFrom(f, from) : f };
    }
    // SerpApi answered synchronously (its own cache): nothing to poll.
    if (Array.isArray(json.jobs_results) || meta.status === 'Success') {
      await release();
      const f = await finish('google_jobs', params, ck, res.status, json, KEEP.google_jobs);
      return { kind: 'result', result: f.ok ? jobsFrom(f, from) : f };
    }
    const id = typeof meta.id === 'string' ? meta.id : '';
    if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
      await release();
      return { kind: 'result', result: { ok: false, reason: 'failed', message: 'SerpApi did not accept the search.' } };
    }
    try {
      await deps.store.put(flight, 'inflight', { searchId: id });
    } catch {
      // sharing is an optimisation
    }
    try {
      await opts.stored?.(id);
    } catch {
      // the caller still holds the id in memory and commits it with the step
    }
    return { kind: 'pending', searchId: id, shared: false };
  } catch (err) {
    await release();
    return { kind: 'result', result: thrown(err) };
  }
}

/**
 * ASYNC poll: one bounded GET of the Search Archive (https://serpapi.com/search-archive-api).
 * `pending` while SerpApi says Queued/Processing (or on a transient blip); otherwise the parsed
 * result, cached by the normalized key.
 */
export async function pollSearchJobs(
  q: string,
  opts: { searchId: string; fromQuery?: number },
): Promise<SearchPoll> {
  const params = JOBS_PARAMS(q);
  const from = opts.fromQuery ?? 0;
  const ck = cacheKey('google_jobs', params);
  const key = deps.env().SERPAPI_API_KEY;
  // Another run (or an earlier, killed poll step) may already have finished this search.
  const hit = await cacheHit(ck, 'google_jobs');
  if (hit) return { kind: 'result', result: jobsFrom(hit, from) };
  if (!key) return { kind: 'result', result: { ok: false, reason: 'not-configured', message: 'No SerpApi key is set.' } };
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(opts.searchId)) {
    return { kind: 'result', result: { ok: false, reason: 'failed', message: 'That search id is not valid.' } };
  }

  let res: Awaited<ReturnType<typeof get>>;
  try {
    res = await get(`${ARCHIVE}/${encodeURIComponent(opts.searchId)}.json?api_key=${encodeURIComponent(key)}`, 'google_jobs');
  } catch {
    return { kind: 'pending' }; // timeout or network blip: the orchestrator's overall cap decides when to give up
  }
  const json = res.json;
  if (res.status === 404) {
    return { kind: 'result', result: { ok: false, reason: 'failed', message: 'SerpApi has no record of that search.' } };
  }
  if (res.status === 429 || res.status >= 500 || !json) return { kind: 'pending' };
  const status = (json.search_metadata as { status?: unknown } | undefined)?.status;
  if (status === 'Queued' || status === 'Processing') return { kind: 'pending' };
  // Never cache an answer under a key it does not belong to: the archive must echo OUR search.
  const meta = json.search_metadata as { id?: unknown } | undefined;
  const echoed = (json.search_parameters as { q?: unknown } | undefined)?.q;
  const norm = (v: string) => v.trim().toLowerCase();
  if (
    (typeof meta?.id === 'string' && meta.id !== opts.searchId) ||
    (typeof echoed === 'string' && norm(echoed) !== norm(q))
  ) {
    return { kind: 'result', result: { ok: false, reason: 'failed', message: 'SerpApi returned a different search than requested.' } };
  }
  if (status === 'Error' && !json.error) json.error = 'The search failed.';
  const f = await finish('google_jobs', params, ck, res.status, json, KEEP.google_jobs);
  await deps.store.releaseInflight(`inflight:${ck}`).catch(() => undefined);
  return { kind: 'result', result: f.ok ? jobsFrom(f, from) : f };
}

/* ------------------------------------------------------------------- intel -- */

export async function companyNews(
  company: string,
  userId: string,
): Promise<SerpResult<EmployerIntel['headlines']>> {
  void userId;
  // Exact phrase + disambiguator: a bare common-phrase name ("Quest", "Open Systems") matches unrelated news.
  const r = await call('google_news', { q: `"${company}" company India`, gl: 'in', hl: 'en' }, false);
  return r.ok ? done(r, parseNews(r.json, 3, company)) : r;
}

/** Ratings via plain Google search of review sites (rich snippets). Optional: any failure is just "no rating". */
async function googleRating(company: string): Promise<SerpResult<ReturnType<typeof parseGoogleRating>>> {
  const r = await call('google', { q: `${company} reviews`, gl: 'in', hl: 'en', google_domain: 'google.co.in' }, false);
  return r.ok ? done(r, parseGoogleRating(r.json, company)) : r;
}

/**
 * Ratings (google_jobs_listing) + headlines (google_news) + a google rating fallback.
 * Deliberately SYNCHRONOUS, and ALL THREE calls run in parallel (the listing is empty for most
 * postings, so the review-site rating is wanted anyway; it is only used when the listing has none).
 * Every call is hard-bounded at 8s as a whole (headers + body), a cold account.json at 2s, so the
 * step is provably <= ~10s + DB time, inside any host's limit. A missing part degrades, it does
 * not fail. Results are cached per call, so a re-run of a killed step is served from the cache.
 * INTEL_REBILL (known limit): per-call completion is not stored, so a killed or overlapped
 * intel step that had not cached a call yet re-calls upstream (the credit reservation itself is idempotent).
 */
export async function companyIntel(
  company: string,
  serpJobId: string,
  userId: string,
): Promise<SerpResult<EmployerIntel>> {
  const [listing, news, g] = await Promise.all([
    serpJobId
      ? // SerpApi docs: q "defines the job_id string which can be obtained from Google Jobs API"
        // (the page's example is a base64 JSON blob, which is what google_jobs returns as job_id).
        // VERIFIED live (2026-10-06): the job_id from google_jobs is accepted as q; a listing with no ratings
        // answers 'hasn't returned any results' (an empty ok, but billed 1 credit: verified 2026-10-08). Documented response field: ratings[].
        // A failure here is non-fatal: ratings just degrade to none.
        call('google_jobs_listing', { q: serpJobId, gl: 'in', hl: 'en', google_domain: 'google.co.in' }, false)
      : Promise.resolve<Fail>({ ok: false, reason: 'failed', message: 'No job id to look ratings up with.' }),
    companyNews(company, userId),
    googleRating(company),
  ]);
  let base = listing.ok ? parseListing(listing.json, company) : parseListing({}, company);
  // google_jobs_listing answers "Fully empty" for most postings (live 2026-10-06, big employers too):
  // use the review-site rich snippets of the parallel Google search. Never invented; in replay only
  // when a sample exists (then the whole result is labelled replay).
  if (!base.rating && g.ok) base = { ...base, ...g.data };
  if (!listing.ok && !news.ok && !g.ok) return news;
  // Every ok part counts for credits (the rating search was billed even when the listing had a rating).
  const parts = [listing, news, g].filter((p) => p.ok) as Extract<SerpResult<unknown>, { ok: true }>[];
  return {
    ok: true,
    data: { ...base, headlines: news.ok ? news.data : [] },
    cached: parts.every((p) => p.cached),
    mode: parts.some((p) => p.mode === 'replay') ? 'replay' : 'live',
    credits: parts.reduce((n, p) => n + p.credits, 0),
  };
}
