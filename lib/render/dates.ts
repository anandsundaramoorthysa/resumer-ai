/**
 * Date formatting — REQ-6.1.
 *
 * Spelled-out month names only. Numeric dates like "5/1/09" parse differently
 * depending on the locale the parsing engine guesses (US MM/DD vs EU DD/MM), which is
 * a documented failure mode in Textkernel's own docs — not folklore. This module is
 * the only place dates become strings, so the rule cannot be bypassed by accident.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Accepts 'YYYY-MM', 'YYYY-MM-DD', 'YYYY', or 'present'. */
export function formatDate(value: string | 'present' | undefined): string {
  if (!value) return '';
  const v = value.trim();
  if (v.toLowerCase() === 'present' || v.toLowerCase() === 'current') return 'Present';

  const match = /^(\d{4})(?:-(\d{1,2}))?/.exec(v);
  if (!match) return v; // already human-written — leave it alone

  const year = match[1];
  const monthNum = match[2] ? Number(match[2]) : null;
  if (!monthNum || monthNum < 1 || monthNum > 12) return year;
  return `${MONTHS[monthNum - 1]} ${year}`;
}

export function formatDateRange(
  start: string | undefined,
  end: string | 'present' | undefined,
): string {
  const s = formatDate(start);
  const e = formatDate(end);
  if (!s && !e) return '';
  if (!s) return e;
  if (!e) return s;
  return `${s} – ${e}`; // en dash
}

/**
 * Detects numeric date patterns that must never reach a rendered document.
 *
 * A date repeats its separator — 07/05/2023, 7-5-23, 12.03.2024 — so the first form
 * requires the same one twice (`\1`). It used to accept any mix, which read a grade of
 * "7.5 / 10" as day 7, month 5, year 10: the owner's B.Sc. line failed `spelled-out-dates`
 * on every EA draft, capping formatting at 10/11 (0.27 of the overall score), and no
 * revision could clear it because there was no date there to rewrite.
 */
export const NUMERIC_DATE_PATTERN =
  /\b\d{1,2}\s*([\/\-.])\s*\d{1,2}\s*\1\s*\d{2,4}\b|\b\d{1,2}\s*\/\s*\d{4}\b/;

export function containsNumericDate(text: string): boolean {
  return NUMERIC_DATE_PATTERN.test(text);
}
