/**
 * What order each section of the profile is shown in.
 *
 * There was no order at all: both queries on /profile returned rows in whatever order
 * Postgres handed them back — effectively the order they were written — so Experience read
 * oldest job first, a degree from school sat above a master's, and certifications appeared
 * in import order. A resume is read top-down and every convention for these sections is
 * the same one: most recent first. The page that edits the profile should show what the
 * resume will.
 *
 * Not every section is chronological, and pretending otherwise is worse than no order:
 *
 *   - Dated sections — education, certifications, publications, writing, awards,
 *     achievements, volunteering — sort newest first on their own date field, and an
 *     entry with no date sorts last rather than first, because "no date" is not "today".
 *   - Projects carry no date in this app, so they are ordered by when they were last
 *     touched: the thing worked on most recently is the thing most likely being edited.
 *   - Skills are grouped the way the resume groups them, by category, then alphabetically
 *     inside each group — a list to scan, not a history.
 *   - Languages and interests are alphabetical for the same reason.
 *   - A summary is a single fact; the newest wins, which is what the assembler does too.
 *
 * Roles are ordered by `rolesByRecency` in lib/generate/assemble.ts — the same function the
 * resume uses, so the two cannot drift apart.
 *
 * Pure, so the rules are tested without a database or a browser.
 */

import { SKILL_CATEGORIES } from '../skills/categories';

/** The field each type dates itself by, where it has one. */
const DATE_FIELD: Record<string, string> = {
  education: 'endDate',
  certification: 'issuedDate',
  publication: 'date',
  writing: 'date',
  award: 'date',
  achievement: 'date',
  volunteering: 'date',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A date as a sortable number, newest highest. Anything unreadable is `null` — the caller
 * sends those to the end.
 *
 * The stored forms are "2024", "2024-06", "present" and whatever a person typed. "present"
 * is above every real date because it is still happening; a bare year sorts as its middle
 * month so that "2024" lands between "2024-01" and "2024-12" rather than before both.
 */
export function dateRank(value: unknown): number | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (/^(present|current|now|ongoing)$/.test(raw)) return Number.MAX_SAFE_INTEGER;
  const match = /(\d{4})(?:[-/.](\d{1,2}))?/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year) || year < 1900 || year > 2200) return null;
  let month = match[2] ? Math.min(12, Math.max(1, Number(match[2]))) : 6;
  // "Dec 2024", "September 2023", "06/2024": a month written as a word or before the year.
  // Without this "Dec 2024" and "Mar 2024" both ranked as the year's middle month and a
  // newest-first sort left them in arbitrary order.
  if (!match[2]) {
    const word = /(?<![a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/.exec(raw);
    if (word) month = MONTH_NAMES.indexOf(word[1]) + 1;
    else {
      const numeric = /(?<!\d)(\d{1,2})[-/.]\d{4}/.exec(raw);
      if (numeric && Number(numeric[1]) >= 1 && Number(numeric[1]) <= 12) month = Number(numeric[1]);
    }
  }
  return year * 100 + month;
}

interface OrderableRecord {
  type: string;
  data: Record<string, unknown>;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

const time = (value: Date | string | null | undefined): number =>
  value ? new Date(value).getTime() || 0 : 0;

const text = (record: OrderableRecord, field: string): string =>
  String(record.data[field] ?? '').trim().toLowerCase();

/** Newest first for anything dated; the undated keep their place at the end. */
function byDateThenRecent<T extends OrderableRecord>(records: T[], field: string): T[] {
  return [...records].sort((a, b) => {
    const ra = dateRank(a.data[field]);
    const rb = dateRank(b.data[field]);
    if (ra !== rb) {
      if (ra === null) return 1;
      if (rb === null) return -1;
      return rb - ra;
    }
    // Same date, or both undated: the one touched most recently is the live one.
    return time(b.updatedAt ?? b.createdAt) - time(a.updatedAt ?? a.createdAt);
  });
}

const CATEGORY_RANK = new Map<string, number>(SKILL_CATEGORIES.map((c, i) => [c as string, i]));

/**
 * One section's records in the order the page should show them. Unknown types keep the
 * order they arrived in, which is the safe answer for a type this module has not met.
 */
export function orderRecords<T extends OrderableRecord>(type: string, records: T[]): T[] {
  const dateField = DATE_FIELD[type];
  if (dateField) return byDateThenRecent(records, dateField);

  switch (type) {
    case 'skill':
      return [...records].sort((a, b) => {
        const ca = CATEGORY_RANK.get(String(a.data.category ?? '')) ?? SKILL_CATEGORIES.length;
        const cb = CATEGORY_RANK.get(String(b.data.category ?? '')) ?? SKILL_CATEGORIES.length;
        return ca - cb || text(a, 'name').localeCompare(text(b, 'name'));
      });
    case 'language':
    case 'interest':
      return [...records].sort((a, b) => text(a, 'name').localeCompare(text(b, 'name')));
    case 'project':
    case 'summary':
      return [...records].sort(
        (a, b) => time(b.updatedAt ?? b.createdAt) - time(a.updatedAt ?? a.createdAt),
      );
    default:
      return records;
  }
}
