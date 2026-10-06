/**
 * Radar ranker — deterministic, no model call, no network. This module must never import lib/ai/*.
 * Postings are scored against the profile by a fixed skill lexicon + the gate's own matcher.
 */

import type { ContactInfo, JobRequirement, ProfileRecord, RoleRecord } from '../types';
import type { Posting, RankedPosting } from '../serp/types';
import { gatherFitFacts } from '../fit/assess';
import { keywordMatches, normalizeForMatch } from '../quality/keywords';

export const SKILL_LEXICON = [
  'python', 'java', 'javascript', 'typescript', 'golang', 'rust', 'c++', 'c#', 'php', 'ruby', 'kotlin', 'swift', 'scala',
  'react', 'next.js', 'node.js', 'angular', 'vue', 'express', 'django', 'flask', 'fastapi', 'spring boot', '.net',
  'html', 'css', 'tailwind', 'redux', 'graphql', 'rest api', 'microservices',
  'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'kafka', 'snowflake', 'bigquery', 'spark', 'hadoop',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'ci/cd', 'jenkins', 'git', 'linux',
  'machine learning', 'deep learning', 'nlp', 'pytorch', 'tensorflow', 'pandas', 'numpy', 'scikit-learn', 'llm', 'generative ai',
  'power bi', 'tableau', 'excel', 'data visualization', 'data analysis', 'etl', 'airflow', 'dbt',
  'figma', 'ui/ux', 'agile', 'scrum', 'jira', 'seo', 'product management', 'selenium', 'testing', 'android', 'ios', 'flutter',
];

export const MAX_POSTINGS = 50;

/** Lexicon skills a text mentions. Normalises the text once; one scan per lexicon term. */
export function mentionedSkills(text: string): string[] {
  const hay = normalizeForMatch(text);
  return SKILL_LEXICON.filter((s) => keywordMatches(hay, s));
}

const SENIORITY_RANK = { intern: 0, entry: 1, mid: 2, senior: 3, lead: 4 } as const;

export function seniorityOf(title: string): JobRequirement['seniority'] {
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b|\btrainee\b/.test(t)) return 'intern';
  if (/\b(lead|principal|staff|head|manager|architect)\b/.test(t)) return 'lead';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|associate|graduate|entry)\b|\bfresher/.test(t)) return 'entry';
  return 'unknown';
}

function profileSeniority(years: number): keyof typeof SENIORITY_RANK {
  return years < 0.5 ? 'intern' : years < 2 ? 'entry' : years < 5 ? 'mid' : 'senior';
}

function seniorityBonus(title: string, years: number): number {
  const s = seniorityOf(title);
  if (s === 'unknown') return 3;
  const diff = Math.abs(SENIORITY_RANK[s] - SENIORITY_RANK[profileSeniority(years)]);
  return diff === 0 ? 10 : diff === 1 ? 5 : 0;
}

function locationBonus(posting: Posting, city: string | null): number {
  const loc = posting.location.toLowerCase();
  if (/remote|anywhere/.test(loc)) return 5;
  return city && loc.includes(city) ? 5 : 0;
}

export function rankPostings(
  postings: Posting[],
  profile: { records: ProfileRecord[]; roles: RoleRecord[]; contact: ContactInfo },
  topK = 5,
): RankedPosting[] {
  const city = profile.contact.location?.split(',')[0]?.trim().toLowerCase() || null;
  const ranked = postings.slice(0, MAX_POSTINGS).map((p): RankedPosting => {
    const text = `${p.title}\n${p.highlights.join('\n')}\n${p.description}`;
    const skills = mentionedSkills(text);
    const job: JobRequirement = {
      roleTitle: p.title, company: p.company, seniority: seniorityOf(p.title), category: 'general',
      requiredSkills: [], preferredSkills: [], responsibilities: [], atsKeywords: skills,
      tone: 'neutral', confidence: 1, flags: [],
    };
    const facts = gatherFitFacts({ job, ...profile });
    const matched = facts.skills.filter((s) => s.held).map((s) => s.keyword);
    const missing = facts.skills.filter((s) => !s.held).map((s) => s.keyword);
    const coverage = facts.skills.length === 0 ? 0 : facts.skillsCoveragePct;
    const short = p.description.trim().length < 200 && p.highlights.length === 0;
    const raw = coverage * 80 + seniorityBonus(p.title, facts.yearsHeld) + locationBonus(p, city);
    const score = Math.round(Math.min(100, short ? raw * 0.6 : raw));
    const reason =
      skills.length === 0
        ? short
          ? 'Short description, so the fit is a rough guess.'
          : 'No recognisable skills in the posting to compare.'
        : `You hold ${matched.length} of ${skills.length} skills it names${missing.length ? `; missing ${missing.slice(0, 3).join(', ')}` : ''}${short ? ' (short description, rough estimate)' : ''}.`;
    return { key: p.key, score, coveragePct: Math.round(coverage * 100), matched, missing, reason };
  });
  return ranked
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, topK);
}
