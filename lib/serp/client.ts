/**
 * SerpApi over plain fetch. One call = one credit; identical params are served from
 * `serp_cache` (1h jobs, 24h news/listing). Never logs or returns a URL: the key rides in
 * the query string, so every message is generic and passed through `scrub`.
 *
 * Replay mode (no key, SERP_MODE=replay, or the budget guard blocking) answers from
 * fixtures/serpapi and labels the result mode:'replay'.
 */

import { budgetBlocked, cacheKey, deps, scrub } from './budget';
import { loadFixture, recordFixture } from './fixtures';
import { dedupePostings, normalizeJobs, parseListing, parseNews } from './normalize';
import type { EmployerIntel, Posting, SerpResult } from './types';

export { creditStatus, scrub } from './budget';
export { dedupePostings } from './normalize';
export { parseSalaryLpa } from './salary';

const ENDPOINT = 'https://serpapi.com/search.json';
const HOUR = 3_600_000;
const TTL = { google_jobs: HOUR, google_news: 24 * HOUR, google_jobs_listing: 24 * HOUR } as const;
type Engine = keyof typeof TTL;

const RESTRICTOR: Record<Engine, string> = {
  google_jobs:
    'jobs_results[].{job_id,title,company_name,location,via,description,detected_extensions,job_highlights,apply_options},serpapi_pagination,search_metadata,error',
  google_news: 'news_results[].{title,link,source,date},search_metadata,error',
  google_jobs_listing: '',
};

type Raw = { ok: true; json: unknown; cached: boolean; mode: 'live' | 'replay'; credits: number };
type Fail = Extract<SerpResult<never>, { ok: false }>;

async function call(
  engine: Engine,
  params: Record<string, string>,
  refresh: boolean,
): Promise<Raw | Fail> {
  const env = deps.env();
  const key = env.SERPAPI_API_KEY;
  const sm = env.SERP_MODE;
  const q = params.q ?? '';

  const replay = (): Raw | Fail => {
    const json = loadFixture(engine, q);
    return json
      ? { ok: true, json, cached: false, mode: 'replay', credits: 0 }
      : { ok: false, reason: 'not-configured', message: 'No SerpApi key is set and no sample data is available.' };
  };

  if (!key || sm === 'replay') return replay();

  const ck = cacheKey(engine, params);
  if (!refresh && sm !== 'record') {
    try {
      const hit = await deps.store.get(ck);
      if (hit && deps.now() - hit.fetchedAt.getTime() < TTL[engine]) {
        return { ok: true, json: hit.payload, cached: true, mode: 'live', credits: 0 };
      }
    } catch {
      // a cache that cannot be read is a miss, not a failure
    }
  }

  if (await budgetBlocked()) return replay();

  const qs = new URLSearchParams({ ...params, engine, api_key: key });
  if (refresh) qs.set('no_cache', 'true');
  if (RESTRICTOR[engine]) qs.set('json_restrictor', RESTRICTOR[engine]);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
  try {
    const res = await deps.fetch(`${ENDPOINT}?${qs.toString()}`, { signal: ctrl.signal });
    const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (!res.ok || !json || json.error) {
      const msg = scrub(typeof json?.error === 'string' ? json.error : `SerpApi answered ${res.status}.`);
      // "hasn't returned any results" is an empty answer, not a failure.
      if (json && /hasn't returned any results/i.test(msg)) return { ok: true, json: {}, cached: false, mode: 'live', credits: 1 };
      const reason = res.status === 429 ? 'rate' : /run out|searches left|plan/i.test(msg) ? 'budget' : 'failed';
      return { ok: false, reason, message: msg };
    }
    if (sm === 'record') recordFixture(engine, q, json);
    try {
      await deps.store.put(ck, engine, json);
    } catch {
      // caching is an optimisation
    }
    return { ok: true, json, cached: false, mode: 'live', credits: 1 };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      reason: 'failed',
      message: timedOut ? 'SerpApi took too long.' : scrub('SerpApi could not be reached.'),
    };
  } finally {
    clearTimeout(timer);
  }
}

const done = <T>(r: Raw, data: T): SerpResult<T> => ({
  ok: true,
  data,
  cached: r.cached,
  mode: r.mode,
  credits: r.credits,
});

/** Page 1 of Google Jobs India. Put the city in `q` ("react developer Bengaluru"). */
export async function searchJobs(
  q: string,
  opts: { userId: string; refresh?: boolean; fromQuery?: number } = { userId: '' },
): Promise<SerpResult<Posting[]>> {
  const r = await call('google_jobs', { q, gl: 'in', hl: 'en', google_domain: 'google.co.in' }, !!opts.refresh);
  return r.ok ? done(r, dedupePostings(normalizeJobs(r.json, opts.fromQuery ?? 0))) : r;
}

export async function companyNews(
  company: string,
  userId: string,
): Promise<SerpResult<EmployerIntel['headlines']>> {
  void userId;
  const r = await call('google_news', { q: company, so: '1', gl: 'in', hl: 'en' }, false);
  return r.ok ? done(r, parseNews(r.json)) : r;
}

/** Ratings (google_jobs_listing) + headlines (google_news). A missing half degrades, it does not fail. */
export async function companyIntel(
  company: string,
  serpJobId: string,
  userId: string,
): Promise<SerpResult<EmployerIntel>> {
  const [listing, news] = await Promise.all([
    serpJobId
      ? call('google_jobs_listing', { q: serpJobId, gl: 'in', hl: 'en', google_domain: 'google.co.in' }, false)
      : Promise.resolve<Fail>({ ok: false, reason: 'failed', message: 'No job id to look ratings up with.' }),
    companyNews(company, userId),
  ]);
  if (!listing.ok && !news.ok) return news;
  const base = listing.ok ? parseListing(listing.json, company) : parseListing({}, company);
  const parts = [listing, news].filter((p) => p.ok);
  return {
    ok: true,
    data: { ...base, headlines: news.ok ? news.data : [] },
    cached: parts.every((p) => p.ok && p.cached),
    mode: parts.some((p) => p.ok && p.mode === 'replay') ? 'replay' : 'live',
    credits: parts.reduce((n, p) => n + (p.ok ? p.credits : 0), 0),
  };
}
