/** Radar planner — one fast-tier model call, with a deterministic rules-only fallback. */

import type { ContactInfo, ProfileRecord, RoleRecord } from '../types';
import { PlanSchema, type Plan } from '../serp/types';
import { generateStructured } from '../ai/chain';
import { draftCallOptions, type DraftBudget } from '../ai/budget';
import { yearsOfWork } from '../fit/assess';
import { normalizeCity, profileSeniority, seniorityOf } from './ranker';

export const DEFAULT_CITY = 'Bengaluru';
const DIGEST_MAX = 1200;
const PROGRAMMING = new Set(['python', 'java', 'javascript', 'typescript', 'go', 'golang', 'rust', 'c++', 'c#', 'php', 'ruby', 'kotlin', 'swift', 'scala']);
const STOP = new Set(['and', 'the', 'of', 'at', 'in', 'for', 'a', 'an', 'to', 'city', 'recent', 'roles', 'skills', 'none']);

type Generate = (args: Parameters<typeof generateStructured<Plan>>[0]) => Promise<{ data: Plan }>;

const NICE_CITY: Record<string, string> = { bengaluru: 'Bengaluru', gurugram: 'Gurugram', mumbai: 'Mumbai', chennai: 'Chennai', kolkata: 'Kolkata' };
const isRemote = (s: string) => /^remote$|^remote\b/i.test(s.trim());

/** First real city in "City, State, Country" (or "Remote, Pune"); "Remote" only when nothing else; old names normalised. */
export function cityOf(contact: ContactInfo): string {
  const parts = (contact.location ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const real = parts.find((p) => !isRemote(p));
  const pick = real ?? parts[0];
  if (!pick) return DEFAULT_CITY;
  const n = normalizeCity(pick);
  return NICE_CITY[n] ?? pick;
}

/** "Engineer at Google" -> "Engineer"; also drops the role's own company if it trails the title. */
function cleanTitle(title: string, company: string): string {
  let t = title.replace(/\s+(?:at|@)\s+.+$/i, '').trim();
  const c = company.trim();
  if (c) t = t.replace(new RegExp(`\\s*[-,|]\\s*${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim();
  return t;
}

function recentTitles(roles: RoleRecord[]): string[] {
  const key = (r: RoleRecord) => (r.endDate === 'present' ? '9999-99' : r.endDate) + r.startDate;
  const seen = new Set<string>();
  return [...roles]
    .sort((a, b) => (key(a) < key(b) ? 1 : -1))
    .map((r) => cleanTitle(r.title, r.company))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

/** Role titles, skill names and city only: no names, companies or contact details. */
export function buildProfileDigest(
  records: ProfileRecord[],
  roles: RoleRecord[],
  contact: ContactInfo,
): string {
  const skills = records.filter((r) => r.type === 'skill').map((r) => r.name).slice(0, 25);
  const out = [
    `City: ${cityOf(contact)}`,
    `Recent roles: ${recentTitles(roles).slice(0, 4).join('; ') || '(none)'}`,
    `Skills: ${skills.join(', ') || '(none)'}`,
  ].join('\n');
  return out.replace(/\S+@\S+|\+?\d[\d\s-]{8,}/g, '').slice(0, DIGEST_MAX);
}

function dedupeQueries(qs: Plan['queries']): Plan['queries'] {
  const seen = new Set<string>();
  return qs
    .filter((x) => {
      const k = x.q.trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 3);
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length > 1 && !STOP.has(t));

/**
 * Hallucination guard: a query must share a token with the digest's titles/skills. A shared
 * city alone is not enough, unless the digest has no titles or skills to compare with.
 */
function groundedQueries(qs: Plan['queries'], digest: string): Plan['queries'] {
  const content = new Set(tokens(digest.split('\n').filter((l) => !/^City:/i.test(l)).join(' ')));
  const city = new Set(tokens(/^City: (.*)$/m.exec(digest)?.[1] ?? ''));
  const universe = content.size > 0 ? content : city;
  return qs.filter((x) => tokens(x.q).some((t) => universe.has(t)));
}

function yearsSeniority(roles: RoleRecord[]): Plan['seniority'] {
  const years = yearsOfWork(roles, new Date());
  if (years > 0) return profileSeniority(years);
  return roles[0] ? seniorityOf(recentTitles(roles)[0] ?? '') : 'unknown';
}

export function rulesPlan(digest: string, roles: RoleRecord[], contact: ContactInfo): Plan {
  const city = cityOf(contact);
  const titles = recentTitles(roles);
  const skillList = /^Skills: (.*)$/m.exec(digest)?.[1]?.split(',').map((s) => s.trim()).filter((s) => s && s !== '(none)') ?? [];
  const top = skillList[0];
  const skillQuery = top ? (PROGRAMMING.has(top.toLowerCase()) ? `${top} developer` : top) : '';
  const years = yearsOfWork(roles, new Date());
  const entryLevel = (years > 0 && years < 2) || (roles.length > 0 && roles.every((r) => seniorityOf(r.title) === 'intern'));

  const title = titles[0] ?? (skillQuery || 'software engineer');
  const qs: Plan['queries'] = [{ q: `${title} ${city}`, why: titles[0] ? 'Matches your most recent role.' : 'Built from your top skill.' }];
  if (skillQuery) qs.push({ q: `${skillQuery} ${city}`, why: 'Matches your top skill.' });
  if (entryLevel) {
    let base = title.replace(/\bintern(ship)?\b/gi, '').trim();
    if (base.length < 4) base = `${base} engineer`.trim();
    qs.push({ q: `${base} fresher ${city}`, why: 'Entry-level variant for early-career profiles.' });
  }
  return {
    queries: dedupeQueries(qs),
    location: city,
    seniority: yearsSeniority(roles),
    rationale: 'Built from your recent role titles, top skill and location (rules-only plan).',
  };
}

export async function planSearch(
  input: { digest: string; roles: RoleRecord[]; contact: ContactInfo; budget?: DraftBudget },
  generate: Generate = generateStructured,
): Promise<Plan> {
  const { digest, roles, contact, budget } = input;
  const fallback = rulesPlan(digest, roles, contact);
  try {
    budget?.assertCanSpend();
    const { data } = await generate({
      schema: PlanSchema,
      system:
        'You plan Google Jobs searches for a candidate. Return at most 3 distinct queries, each formatted "<role> <city>". Use only the roles, skills and city in the digest. Fill every field; use "" when unknown.',
      prompt: `CANDIDATE DIGEST\n${digest}`,
      options: draftCallOptions(budget, { tier: 'fast', temperature: 0.2, maxOutputTokens: 600 }),
    });
    const queries = dedupeQueries(groundedQueries(data.queries, digest));
    if (queries.length === 0) return fallback;
    return {
      ...data,
      queries,
      location: normalizeCity(data.location) ? NICE_CITY[normalizeCity(data.location)] ?? data.location.trim() : fallback.location,
      seniority: data.seniority === 'unknown' ? fallback.seniority : data.seniority,
    };
  } catch {
    return fallback;
  }
}
