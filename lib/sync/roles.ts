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
// Word boundaries are Unicode-aware lookarounds, not \b: \b only knows ASCII word characters.
const W_OPEN = '(?<![\\p{L}\\p{N}\\p{M}])';
const W_CLOSE = '(?![\\p{L}\\p{N}\\p{M}])';
const COMPANY_SUFFIXES = new RegExp(
  `${W_OPEN}(pvt|private|ltd|limited|llp|llc|inc|incorporated|corp|corporation|co|gmbh|technologies|technology|solutions|labs|lab|software|systems|services|self[-\\s]?published|self[-\\s]?employed)${W_CLOSE}`,
  'gu',
);

/** Parenthetical qualifiers on a job title: "(Paid Intern)", "(Contract)", "(Remote)". */
const TITLE_QUALIFIERS = /\([^)]*\)/g;

/** Seniority and engagement words that vary between tellings of the same job. */
const TITLE_NOISE = new RegExp(
  `${W_OPEN}(intern|internship|paid|unpaid|trainee|part[-\\s]?time|full[-\\s]?time|contract|freelance|remote)${W_CLOSE}`,
  'gu',
);
const INTERN_WORDS = new RegExp(`${W_OPEN}(intern|internship|trainee)${W_CLOSE}`, 'iu');

/**
 * Lowercased NFKC text keeping letters, digits and combining marks of every script.
 *
 * The old class was `[^a-z0-9\s/]`, which erased every non-ASCII character: Tamil, Hindi and
 * CJK company and title names all reduced to "", so `roleIdentity` returned "::" for any
 * two of them and `dedupeRoles` merged unrelated jobs. Marks (\p{M}) are kept because Indic
 * vowel signs and viramas are marks — dropping them changes the word. Joiners (ZWJ/ZWNJ)
 * are removed, not spaced, so a conjunct is not cut in two.
 */
function squash(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s/]/gu, ' ')
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

/** A year, or a year and month — the shape every stored role date has. */
export function isRoleDate(value: string): boolean {
  return ROLE_DATE.test(value);
}

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

/**
 * The identity key of a job.
 *
 * Two safeguards against merging jobs that are merely hard to read:
 *  - An empty half (a name that normalises to nothing — a lone emoji, punctuation) means
 *    there is NO identity to compare. The key falls back to the raw NFKC text of both
 *    fields, so only a byte-identical pair can ever collide; "::" used to collide with
 *    every other empty pair.
 *  - `startDate`, when given, adds the start YEAR, so an internship and a later full-time
 *    role under the same title at the same company are two jobs. Callers that compare
 *    stored roles should pass it; `dedupeRoles` applies the stronger date test (`sameJob`).
 */
export function roleIdentity(company: string, title: string, startDate?: string): string {
  const c = normalizeCompany(company);
  const t = normalizeTitle(title);
  if (!c || !t) {
    return `raw:${company.normalize('NFKC').trim().toLowerCase()}|${title.normalize('NFKC').trim().toLowerCase()}`;
  }
  const year = startDate && ROLE_DATE.test(startDate) ? `@${startDate.slice(0, 4)}` : '';
  return `${c}::${t}${year}`;
}

/** A role date as a month number (year * 12 + month0); a bare year spans Jan..Dec. */
function monthSpan(value: string | undefined, edge: 'start' | 'end'): number | null {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'present' || v === 'current' || v === 'ongoing') return edge === 'end' ? Number.MAX_SAFE_INTEGER : null;
  const m = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/.exec(v);
  if (!m) return null;
  const month = m[2] ? Number(m[2]) - 1 : edge === 'start' ? 0 : 11;
  return Number(m[1]) * 12 + month;
}

interface Span { start: number | null; end: number | null }

const spanOf = (r: { startDate: string; endDate: string }): Span => ({
  start: monthSpan(r.startDate, 'start'),
  end: monthSpan(r.endDate, 'end') ?? monthSpan(r.startDate, 'end'),
});

/**
 * Whether two roles with the SAME title identity are the same job, by date.
 *
 * Decision: merge only when the date ranges overlap or sit within one month of each other;
 * a role with no usable dates on either side is compatible (it cannot be told apart, and
 * merging an undated row onto its dated twin is what the live-profile cleanup needs). A
 * gap of more than a month is a different engagement: an internship in 2022 and a full-time
 * role in 2024 under the same title at the same company are two jobs. Back to back
 * (adjacent) stays merged unless one telling says intern and the other does not — that is a
 * conversion to full-time, which is a second role.
 */
function datesCompatible(a: RoleLike, b: RoleLike, aSpan: Span, bSpan: Span): boolean {
  if (aSpan.start === null || bSpan.start === null) return true;
  const aEnd = aSpan.end ?? aSpan.start;
  const bEnd = bSpan.end ?? bSpan.start;
  const gap = Math.max(aSpan.start, bSpan.start) - Math.min(aEnd, bEnd);
  if (gap <= 0) return true; // overlapping
  if (gap > 1) return false;
  return INTERN_WORDS.test(a.title) === INTERN_WORDS.test(b.title);
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

/** Identity AND dates agree — the test `dedupeRoles` applies, for callers matching stored rows. */
export function sameJob(a: RoleLike, b: RoleLike): boolean {
  return (
    roleIdentity(a.company, a.title) === roleIdentity(b.company, b.title) &&
    datesCompatible(a, b, spanOf(a), spanOf(b))
  );
}

/** Collapses a list of roles to one entry per real job. */
export function dedupeRoles(roles: RoleLike[]): RoleLike[] {
  // Several clusters per identity: same title identity + incompatible dates = separate jobs.
  const byIdentity = new Map<string, Array<{ role: RoleLike; span: Span }>>();
  const order: Array<{ role: RoleLike; span: Span }> = [];

  for (const role of roles) {
    for (const title of splitMergedTitles(role.title)) {
      const candidate = { ...role, title };
      const key = roleIdentity(candidate.company, candidate.title);
      const span = spanOf(candidate);
      const clusters = byIdentity.get(key) ?? [];
      const hit = clusters.find((c) => datesCompatible(c.role, candidate, c.span, span));
      if (hit) {
        hit.role = mergeRoles(hit.role, candidate);
        hit.span = {
          start: hit.span.start === null ? span.start : span.start === null ? hit.span.start : Math.min(hit.span.start, span.start),
          end: hit.span.end === null ? span.end : span.end === null ? hit.span.end : Math.max(hit.span.end, span.end),
        };
        continue;
      }
      const fresh = { role: candidate, span };
      clusters.push(fresh);
      byIdentity.set(key, clusters);
      order.push(fresh);
    }
  }

  return order.map((c) => c.role);
}
