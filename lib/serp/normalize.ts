/** SerpApi JSON -> our schemas. Tolerant: every field may be missing. */

import { createHash } from 'node:crypto';
import { parseSalaryLpa } from './salary';
import { PostingSchema, type EmployerIntel, type Posting } from './types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Truncates untrusted text to what the schemas allow. */
const cap = (v: unknown, n: number): string => str(v).slice(0, n);

/** Only absolute http(s) URLs survive (no javascript:, data:, relative, empty); '' otherwise. Never truncated into a different URL. */
function httpUrl(v: unknown): string {
  const s = str(v);
  if (!s || s.length > 500) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : '';
  } catch {
    return '';
  }
}

export function postingKey(title: string, company: string): string {
  return createHash('sha1').update(`${title.toLowerCase()}|${company.toLowerCase()}`).digest('hex');
}

export function normalizeJobs(json: unknown, fromQuery = 0): Posting[] {
  const out: Posting[] = [];
  for (const raw of arr(obj(json).jobs_results)) {
    const j = obj(raw);
    const title = cap(j.title, 200);
    const company = cap(j.company_name, 120);
    if (!title) continue;
    const ext = obj(j.detected_extensions);
    const description = str(j.description);
    const parsed = PostingSchema.safeParse({
      key: postingKey(title, company),
      title,
      company,
      location: cap(j.location, 120),
      via: str(j.via).replace(/^via\s+/i, '').slice(0, 60),
      description,
      applyLinks: arr(j.apply_options)
        .map((o) => ({ title: cap(obj(o).title, 120), link: httpUrl(obj(o).link) }))
        .filter((o) => o.link)
        .slice(0, 6),
      postedAt: str(ext.posted_at),
      scheduleType: str(ext.schedule_type),
      salaryLpa: parseSalaryLpa(description, str(ext.salary) || undefined),
      highlights: arr(j.job_highlights).flatMap((h) => arr(obj(h).items).map((x) => cap(x, 300)).filter(Boolean)).slice(0, 12),
      serpJobId: str(j.job_id),
      fromQuery,
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const richness = (p: Posting) => p.description.length + p.highlights.length * 50;

/** One posting per (title, company): keep the richest description, merge apply links. */
export function dedupePostings(postings: Posting[]): Posting[] {
  const byKey = new Map<string, Posting>();
  for (const p of postings) {
    const prev = byKey.get(p.key);
    if (!prev) {
      byKey.set(p.key, { ...p, applyLinks: [...p.applyLinks] });
      continue;
    }
    const base = richness(p) > richness(prev) ? p : prev;
    const seen = new Set<string>();
    const applyLinks = [...prev.applyLinks, ...p.applyLinks].filter((l) => !seen.has(l.link) && seen.add(l.link)).slice(0, 6);
    byKey.set(p.key, { ...base, applyLinks, fromQuery: Math.min(prev.fromQuery, p.fromQuery) });
  }
  return [...byKey.values()];
}

function count(v: unknown): number {
  if (typeof v === 'number') return v;
  const m = str(v).toLowerCase().replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([km])?/);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
}

/** google_jobs_listing: company ratings only. Rating 0 when absent. */
export function parseListing(json: unknown, company: string): EmployerIntel {
  const j = obj(json);
  const rows = [...arr(j.ratings), ...arr(j.company_ratings)].map(obj);
  const best = rows.find((r) => Number(r.rating) > 0);
  return {
    company,
    rating: best ? Number(best.rating) : 0,
    ratingSource: best ? str(best.source) || str(best.name) || str(best.title) : '',
    reviewsCount: best ? count(best.reviews ?? best.reviews_count) : 0,
    headlines: [],
  };
}

export function parseNews(json: unknown, limit = 3): EmployerIntel['headlines'] {
  return arr(obj(json).news_results)
    .map(obj)
    .map((n) => {
      const s = n.source;
      return {
        title: cap(n.title, 200),
        source: (typeof s === 'string' ? s : str(obj(s).name)).trim().slice(0, 60),
        link: httpUrl(n.link),
        date: cap(n.date, 60),
      };
    })
    .filter((n) => n.title && n.link)
    .slice(0, Math.min(limit, 5));
}
