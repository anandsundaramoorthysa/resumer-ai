/**
 * Role identity and normalisation.
 *
 * Roles are not `ProfileRecord`s, so they never passed through `reconcile()` and its
 * identity matching. They were inserted with `onConflictDoNothing()` keyed on a content
 * hash — and a company written two ways hashes two ways, so every sync appended more.
 * The live profile reached 16 rows for 10 real jobs:
 *
 *   Corizo | Flutter Developer (Paid Intern)   ← same job, two titles
 *   Corizo | Flutter Developer Intern
 *   D2R AI Labs / D2RAI Labs                   ← same company, spaced two ways
 *   DiffuseAi / DiffuseAI                      ← same company, cased two ways
 *   Sparks AI / Sparks AI / Welbuilt AI Solutions Pvt. Ltd.
 *
 * This module gives roles the same normalised identity education now has, so one job is
 * one row however the source happens to spell it.
 */

/** Corporate suffixes that carry no identity — the same company with or without them. */
const COMPANY_SUFFIXES =
  /\b(pvt|private|ltd|limited|llp|llc|inc|incorporated|corp|corporation|co|gmbh|technologies|technology|solutions|labs|lab|software|systems|services|self[-\s]?published|self[-\s]?employed)\b/g;

/** Parenthetical qualifiers on a job title: "(Paid Intern)", "(Contract)", "(Remote)". */
const TITLE_QUALIFIERS = /\([^)]*\)/g;

/** Seniority and engagement words that vary between tellings of the same job. */
const TITLE_NOISE = /\b(intern|internship|paid|unpaid|trainee|part[-\s]?time|full[-\s]?time|contract|freelance|remote)\b/g;

function squash(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "DiffuseAi", "DiffuseAI" and "Sparks AI / Welbuilt AI Solutions Pvt. Ltd." reduce to a
 * stable key. Where a company is given as "A / B" only the first is used: the source
 * writes the parent second, and the first name is the one that stays constant.
 */
/**
 * Names that all mean "no employer". Self-employment gets described differently in
 * different places on the same site — the live profile carried both
 * "Self-Employed / Freelancer" and a dateless "Freelancer / Freelancer" — and they are
 * one working arrangement, not two jobs.
 */
const SELF_EMPLOYMENT = /^(self|selfemployed|freelance|freelancer|independent|own|personal)$/;

export function normalizeCompany(company: string): string {
  const primary = squash(company).split('/')[0] ?? '';
  const stripped = primary.replace(COMPANY_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
  // Spacing inside a name varies ("D2R AI" vs "D2RAI"), so it is removed entirely for
  // the key. This is only an identity key; the display name is never derived from it.
  const key = (stripped || primary).replace(/\s/g, '');
  return SELF_EMPLOYMENT.test(key) ? 'selfemployed' : key;
}

const ROLE_DATE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

/**
 * Why a job's dates cannot be saved, or null when they can. `startDate` and `endDate` are
 * already tidied (lib/steward/tidy.ts), so "Sep 2023" has become "2023-09".
 *
 * A start date is required. An empty one printed as "(no start)" and broke the ATS date
 * arithmetic (specs/AUDIT.md #4), and a year alone is fine — plenty of people do not
 * remember the month. Ranges are compared at the precision both sides have, so "2022" to
 * "2022-05" is not reversed.
 */
export function roleDateProblem(startDate: string, endDate: string): string | null {
  if (!ROLE_DATE.test(startDate)) return 'Give a start date as a year, or a year and month (2022 or 2022-06).';
  if (endDate === 'present') return null;
  if (!ROLE_DATE.test(endDate)) return 'Give an end date as a year, or a year and month — or mark the job as current.';
  const width = Math.min(startDate.length, endDate.length);
  if (endDate.slice(0, width) < startDate.slice(0, width)) return 'The job ends before it starts.';
  return null;
}

/** "Flutter Developer (Paid Intern)" and "Flutter Developer Intern" reduce alike. */
export function normalizeTitle(title: string): string {
  return squash(title.replace(TITLE_QUALIFIERS, ' '))
    .replace(TITLE_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function roleIdentity(company: string, title: string): string {
  return `${normalizeCompany(company)}::${normalizeTitle(title)}`;
}

/**
 * One row per job, even when the source merged several into one title.
 *
 * The live profile contained a single row titled "Artificial Intelligence Intern / Full
 * Stack Developer / Project Manager" alongside the three correct rows for the same
 * company. Splitting on the separator lets the identity match collapse the merged row
 * onto the real ones instead of leaving a fourth, fictional job on the resume.
 */
export function splitMergedTitles(title: string): string[] {
  const parts = title
    .split(/\s+\/\s+|\s+\|\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [title.trim()];
}

export interface RoleLike {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location?: string;
}

/**
 * Picks the better of two tellings of the same job.
 *
 * Longer strings win because the fuller version is the one carrying the detail — "Sparks
 * AI / Welbuilt AI Solutions Pvt. Ltd." over "Sparks AI" — and a present date beats an
 * absent one, since two roles reached the database with no start date at all.
 */
export function mergeRoles(a: RoleLike, b: RoleLike): RoleLike {
  const better = (x?: string, y?: string): string =>
    (x?.trim().length ?? 0) >= (y?.trim().length ?? 0) ? (x ?? '') : (y ?? '');

  return {
    title: better(a.title, b.title),
    company: better(a.company, b.company),
    startDate: a.startDate?.trim() ? a.startDate : (b.startDate ?? ''),
    endDate: a.endDate?.trim() && a.endDate !== 'present' ? a.endDate : (b.endDate ?? a.endDate ?? ''),
    location: better(a.location, b.location) || undefined,
  };
}

/** Collapses a list of roles to one entry per real job. */
export function dedupeRoles(roles: RoleLike[]): RoleLike[] {
  const byIdentity = new Map<string, RoleLike>();

  for (const role of roles) {
    for (const title of splitMergedTitles(role.title)) {
      const candidate = { ...role, title };
      const key = roleIdentity(candidate.company, candidate.title);
      const existing = byIdentity.get(key);
      byIdentity.set(key, existing ? mergeRoles(existing, candidate) : candidate);
    }
  }

  return [...byIdentity.values()];
}
