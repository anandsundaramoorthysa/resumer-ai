/**
 * SerpApi over plain fetch. One call = one credit; identical params are served from
 * `serp_cache` (1h jobs, 24h news/listing). Never logs or returns a URL: the key rides in
 * the query string, so every message is generic and passed through `scrub`.
 *
 * Replay mode (no key, SERP_MODE=replay, or the budget guard blocking) answers from
 * fixtures/serpapi and labels the result mode:'replay'.
 */

import { budgetBlocked, cacheKey, deps, noteAttempt, scrub } from './budget';
import { loadFixture, recordFixture } from './fixtures';
import { dedupePostings, normalizeJobs, parseGoogleRating, parseListing, parseNews } from './normalize';
import type { EmployerIntel, Posting, SerpResult } from './types';

export { creditStatus, scrub } from './budget';
export { dedupePostings } from './normalize';
export { parseSalaryLpa } from './salary';

const ENDPOINT = 'https://serpapi.com/search.json';
const HOUR = 3_600_000;
const TTL = { google_jobs: HOUR, google_news: 24 * HOUR, google_jobs_listing: 24 * HOUR, google: 24 * HOUR } as const;
const EMPTY_TTL = 10 * 60_000;
type Engine = keyof typeof TTL;

const RESTRICTOR: Record<Engine, string> = {
  google_jobs:
    'jobs_results[].{job_id,title,company_name,location,via,description,detected_extensions,job_highlights,extensions,apply_options},serpapi_pagination,search_metadata,error',
  google_news: 'news_results[].{title,link,source,date,snippet},search_metadata,error',
  google: 'organic_results[].{title,link,source,displayed_link,rich_snippet},search_metadata,error',
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
    try {
      return { ok: true, json: loadFixture(engine, q), cached: false, mode: 'replay', credits: 0 };
    } catch {
      return { ok: false, reason: 'not-configured', message: 'No SerpApi key is set and no sample data is available.' };
    }
  };

  if (!key || sm === 'replay') return replay();

  const ck = cacheKey(engine, params);
  if (!refresh && sm !== 'record') {
    try {
      const hit = await deps.store.get(ck);
      const empty = (hit?.payload as { _empty?: unknown } | undefined)?._empty === true;
      if (hit && deps.now() - hit.fetchedAt.getTime() < (empty ? EMPTY_TTL : TTL[engine])) {
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

  // Counted before the call: a failure or timeout may still have been billed. NO auto-retry anywhere.
  await noteAttempt();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.searchTimeoutMs(engine));
  try {
    const res = await deps.fetch(`${ENDPOINT}?${qs.toString()}`, { signal: ctrl.signal });
    const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (!res.ok || !json || json.error) {
      const msg = scrub(typeof json?.error === 'string' ? json.error : `SerpApi answered ${res.status}.`);
      // "hasn't returned any results" is an empty answer, not a failure, and costs no credit.
      // Cached briefly so the same empty query is not paid for again.
      if (json && /hasn't returned any results/i.test(msg)) {
        try {
          await deps.store.put(ck, engine, { _empty: true });
        } catch {
          // caching is an optimisation
        }
        return { ok: true, json: {}, cached: false, mode: 'live', credits: 0 };
      }
      // Out-of-credits is often a 429 too: read the message before the status.
      const reason = /run out|out of (?:searches|credits)|searches left|plan/i.test(msg)
        ? 'budget'
        : res.status === 429
          ? 'rate'
          : 'failed';
      return { ok: false, reason, message: msg };
    }
    if (sm === 'record') recordFixture(engine, q, json);
    try {
      await deps.store.put(ck, engine, json);
    } catch {
      // caching is an optimisation
    }
    // Always 1: SerpApi bills a fresh search one credit and serves its own server-side cache
    // free, but the response carries no documented, reliable marker for which one we got
    // (search_metadata.status is "Success" either way). Reported spend is therefore an upper bound.
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
  if (!r.ok) return r;
  let postings = dedupePostings(normalizeJobs(r.json, opts.fromQuery ?? 0));
  // Replay data is hand-written: label every posting so the UI can show SAMPLE.
  if (r.mode === 'replay') postings = postings.map((p) => ({ ...p, via: 'Sample data' }));
  return done(r, postings);
}

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

/** Ratings (google_jobs_listing) + headlines (google_news). A missing half degrades, it does not fail. */
export async function companyIntel(
  company: string,
  serpJobId: string,
  userId: string,
): Promise<SerpResult<EmployerIntel>> {
  const [listing, news] = await Promise.all([
    serpJobId
      ? // SerpApi docs: q "defines the job_id string which can be obtained from Google Jobs API"
        // (the page's example is a base64 JSON blob, which is what google_jobs returns as job_id).
        // VERIFIED live (2026-10-06): the job_id from google_jobs is accepted as q; a listing with no ratings
        // answers 'hasn't returned any results' (an empty ok, 0 credits). Documented response field: ratings[].
        // A failure here is non-fatal: ratings just degrade to none.
        call('google_jobs_listing', { q: serpJobId, gl: 'in', hl: 'en', google_domain: 'google.co.in' }, false)
      : Promise.resolve<Fail>({ ok: false, reason: 'failed', message: 'No job id to look ratings up with.' }),
    companyNews(company, userId),
  ]);
  let base = listing.ok ? parseListing(listing.json, company) : parseListing({}, company);
  // google_jobs_listing answers "Fully empty" for most postings (live 2026-10-06, big employers too):
  // fall back to review-site rich snippets in a normal Google search. Never in replay, never invented.
  const live = listing.ok ? listing.mode === 'live' : news.ok && news.mode === 'live';
  let g: SerpResult<ReturnType<typeof parseGoogleRating>> | null = null;
  if (!base.rating && live) {
    g = await googleRating(company);
    if (g.ok) base = { ...base, ...g.data };
  }
  if (!listing.ok && !news.ok && !g?.ok) return news;
  const parts = [listing, news, g].filter((p) => p?.ok) as Extract<SerpResult<unknown>, { ok: true }>[];
  return {
    ok: true,
    data: { ...base, headlines: news.ok ? news.data : [] },
    cached: parts.every((p) => p.cached),
    mode: parts.some((p) => p.mode === 'replay') ? 'replay' : 'live',
    credits: parts.reduce((n, p) => n + p.credits, 0),
  };
}
