/**
 * Job-URL resolution — REQ-3.2.
 *
 * Chain: known-blocked domain -> straight to manual paste (don't waste the call)
 *        otherwise           -> Firecrawl scrape
 *        scrape fails        -> manual paste
 *
 * LinkedIn, Indeed and Glassdoor run Datadome/PerimeterX and block scrapers outright,
 * Firecrawl included. Detecting them up front turns a guaranteed failure into an
 * instant, honest "paste the text instead" rather than a slow timeout.
 */

const BLOCKED_DOMAINS = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'glassdoor.co.in',
  'ziprecruiter.com',
];

export type ScrapeOutcome =
  | { ok: true; text: string; source: 'firecrawl' }
  | { ok: false; reason: 'blocked-domain' | 'scrape-failed' | 'not-configured'; message: string };

export function isBlockedDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export function looksLikeUrl(input: string): boolean {
  const t = input.trim();
  if (/\s/.test(t)) return false;
  return /^https?:\/\//i.test(t) || /^[\w-]+(\.[\w-]+)+\/?/.test(t);
}

export function normalizeUrl(input: string): string {
  const t = input.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

/**
 * The longest a scrape may take. It was 45 seconds, inside a fit check with a 22-second
 * budget inside a 30-second function: a slow careers page killed the request outright,
 * and the user saw "connection closed" instead of being asked to paste the text.
 */
export const MAX_SCRAPE_MS = 12_000;

export async function scrapeJobUrl(rawUrl: string, timeoutMs = MAX_SCRAPE_MS): Promise<ScrapeOutcome> {
  const url = normalizeUrl(rawUrl);

  if (isBlockedDomain(url)) {
    return {
      ok: false,
      reason: 'blocked-domain',
      message:
        'This site blocks automated readers (LinkedIn, Indeed and Glassdoor all do). Paste the posting text instead — it works just as well.',
    };
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;

  // Firecrawl has a rate-limited keyless tier. It refuses some IP ranges, so it is not
  // something to rely on — but attempting it costs one request and means a missing key
  // degrades to "might still work" instead of "definitely won't".
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, MAX_SCRAPE_MS)),
    });

    if (!res.ok) {
      return {
        ok: false,
        reason: apiKey ? 'scrape-failed' : 'not-configured',
        message: apiKey
          ? `Couldn't read that page (${res.status}). Paste the posting text instead.`
          : "Couldn't fetch that link without a Firecrawl API key. Paste the posting text instead — that always works.",
      };
    }

    const json = (await res.json()) as {
      data?: { markdown?: string };
      markdown?: string;
    };
    const text = json.data?.markdown ?? json.markdown ?? '';

    if (text.trim().length < 120) {
      return {
        ok: false,
        reason: 'scrape-failed',
        message:
          "That page didn't return enough readable text — it may be JavaScript-gated. Paste the posting text instead.",
      };
    }

    return { ok: true, text, source: 'firecrawl' };
  } catch (err) {
    return {
      ok: false,
      reason: 'scrape-failed',
      message:
        err instanceof Error && err.name === 'TimeoutError'
          ? 'That page took too long to load. Paste the posting text instead.'
          : "Couldn't reach that page. Paste the posting text instead.",
    };
  }
}
