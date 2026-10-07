/**
 * Layer 1 of the profile steward (STEWARD.md §3): the changes that cannot alter a fact.
 *
 * Every path into the profile — a form, the bullet editor, an import, a LinkedIn export,
 * a sync, an answered question — ends in one of a handful of writers, and each one calls
 * this before hashing and storing. What it does is only ever spelling and typography:
 *
 *   - look-alike hyphens, non-breaking and zero-width spaces become their plain forms. The
 *     owner's live bullets held U+2011, which the PDF font cannot draw and an ATS reads as
 *     no hyphen at all ("open‑source" → "opensource").
 *   - runs of whitespace collapse; ends are trimmed.
 *   - a skill takes its canonical spelling ("typescript" → "TypeScript"), and a project's
 *     stack loses repeats of one skill spelled two ways.
 *   - a description that only repeats the title is dropped — all six synced achievements
 *     printed their title twice.
 *   - a single month written in words becomes `YYYY-MM`, the one date shape every reader
 *     of these fields understands.
 *
 * Nothing here chooses between readings, so nothing here asks. Anything that needs
 * judgement — a better word, a merge, a different record type — is layer 2, where the
 * user approves it.
 */

import { printable } from '../generate/display-text';
import { canonicalSkillName, dedupeStackNames } from '../skills/identity';

/** Built from code points: these characters are invisible, so they are not typed inline. */
const chars = (...codes: number[]) => new RegExp(`[${String.fromCharCode(...codes)}]`, 'g');
/**
 * Zero-width space, byte-order mark, word joiner. NOT U+200C / U+200D: ZWNJ and ZWJ are
 * meaningful characters, not noise. They select conjunct vs. explicit-virama forms in
 * Devanagari and Malayalam ("क्‍ष"), shape Persian and Arabic words, and glue ZWJ emoji
 * sequences (family, profession). Stripping them silently changed the spelling.
 */
const ZERO_WIDTH = chars(0x200b, 0xfeff, 0x2060);
/** No-break space, figure space, narrow no-break space. */
const ODD_SPACES = chars(0x00a0, 0x2007, 0x202f);

/** Plain text, one line of whitespace, look-alike characters replaced. */
export function tidyText(value: string): string {
  return printable(value)
    .replace(ZERO_WIDTH, '')
    .replace(ODD_SPACES, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * One date, written the way the rest of the app reads dates.
 *
 * Only unambiguous single dates are rewritten: "Sep 2023", "September 2023", "2023/09",
 * "09/2023". A range ("Jun 2025 – Apr 2026") or anything else is left exactly as written,
 * because guessing which half is meant is a decision, not a spelling.
 */
export function tidyDate(value: string): string {
  const v = tidyText(value);
  if (/^(present|current|now|ongoing)$/i.test(v)) return 'present';
  let m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(v);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${MONTHS[m[1].toLowerCase()]}`;
  m = /^(\d{4})[/.](\d{1,2})$/.exec(v);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.](\d{4})$/.exec(v);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${m[2]}-${m[1].padStart(2, '0')}`;
  return v;
}

const DATE_FIELDS = new Set(['startDate', 'endDate', 'issuedDate', 'date']);

/** Letters and digits only, so "Title." and "title" compare as the same words. */
const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The record's fields with layer-1 tidying applied. Returns a new object; the caller's
 * is untouched. Unknown fields are tidied as text too, so a writer that stores an extra
 * key (a skill's `evidence`) gets the same treatment.
 */
export function tidyRecordData(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      out[key] = DATE_FIELDS.has(key) ? tidyDate(value) : tidyText(value);
    } else if (Array.isArray(value)) {
      out[key] = value
        .map((v) => (typeof v === 'string' ? tidyText(v) : v))
        .filter((v) => v !== '');
    } else {
      out[key] = value;
    }
  }

  if (type === 'skill' && typeof out.name === 'string') {
    out.name = canonicalSkillName(out.name);
  }
  if (type === 'project' && Array.isArray(out.stack)) {
    out.stack = dedupeStackNames(out.stack.filter((s): s is string => typeof s === 'string'));
  }
  if (
    typeof out.description === 'string' &&
    typeof out.title === 'string' &&
    out.description &&
    bare(out.description) === bare(out.title)
  ) {
    delete out.description;
  }
  return out;
}
