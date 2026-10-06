/** Radar planner — one fast-tier model call, with a deterministic rules-only fallback. */

import type { ContactInfo, ProfileRecord, RoleRecord } from '../types';
import { PlanSchema, type Plan } from '../serp/types';
import { generateStructured } from '../ai/chain';
import { draftCallOptions, type DraftBudget } from '../ai/budget';
import { seniorityOf } from './ranker';

export const DEFAULT_CITY = 'Bengaluru';
const DIGEST_MAX = 1200;

type Generate = (args: Parameters<typeof generateStructured<Plan>>[0]) => Promise<{ data: Plan }>;

const cityOf = (contact: ContactInfo) => contact.location?.split(',')[0]?.trim() || DEFAULT_CITY;

function recentTitles(roles: RoleRecord[]): string[] {
  const key = (r: RoleRecord) => (r.endDate === 'present' ? '9999-99' : r.endDate) + r.startDate;
  const seen = new Set<string>();
  return [...roles]
    .sort((a, b) => (key(a) < key(b) ? 1 : -1))
    .map((r) => r.title.trim())
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
  return out.slice(0, DIGEST_MAX);
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

export function rulesPlan(digest: string, roles: RoleRecord[], contact: ContactInfo): Plan {
  const city = cityOf(contact);
  const titles = recentTitles(roles);
  const firstSkill = /^Skills: (.*)$/m.exec(digest)?.[1]?.split(',')[0]?.trim();
  const bases = titles.slice(0, 2);
  if (bases.length === 0) {
    bases.push(firstSkill && firstSkill !== '(none)' ? `${firstSkill} developer` : 'software engineer');
  }
  return {
    queries: dedupeQueries(bases.map((b) => ({ q: `${b} ${city}`, why: 'Matches a recent role on your profile.' }))),
    location: city,
    seniority: titles[0] ? seniorityOf(titles[0]) : 'unknown',
    rationale: 'Built from your recent role titles and location (rules-only plan).',
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
      options: draftCallOptions(budget, { tier: 'fast', temperature: 0.2 }),
    });
    const queries = dedupeQueries(data.queries);
    if (queries.length === 0) return fallback;
    return { ...data, queries, location: data.location.trim() || fallback.location };
  } catch {
    return fallback;
  }
}
