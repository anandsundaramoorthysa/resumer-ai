/**
 * The same fact stored twice — in every section, not only in Skills.
 *
 * Skills had a duplicate rule and bullets had a near-duplicate rule; a project, a
 * certification, a degree, an award, a publication or a language could sit in the profile
 * two or three times and nothing said so. They arrive that way honestly: one from an old
 * resume import, one from the portfolio sync, one typed by hand, each worded slightly
 * differently. On the resume they print twice, which reads as padding in exactly the
 * section that is supposed to be evidence.
 *
 * Matching is per type, on the fields that identify the thing rather than on every word:
 * a project is its name, a certification its name and issuer, a degree its institution and
 * credential (the sync's own normalisers are reused, so this agrees with reconcile), and
 * the rest their title. Normalised to letters and digits, so "Hackathon Winner!" and
 * "hackathon winner" are one, and "Data Science" and "Data Analysis" stay two — this rule
 * never guesses that two different things are the same.
 *
 * What it proposes is a merge that keeps the fullest copy, which the user still has to
 * accept. Nothing here deletes anything on its own.
 */

import { certificationIdentity } from '../sync/certifications';
import { educationIdentity } from '../sync/education';
import type { StewardRecord, Suggestion } from './types';

type Draft = Omit<Suggestion, 'id'>;

/** Letters and digits only: punctuation, case and spacing never make two things different. */
function bare(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

const str = (record: StewardRecord, field: string) => String(record.data[field] ?? '');

/**
 * What makes this record that record, or null when the type is handled elsewhere or has
 * nothing stable to compare (a summary — there is only ever one — and skills and bullets,
 * which have their own rules in ./rules.ts).
 */
export function duplicateKey(record: StewardRecord): string | null {
  switch (record.type) {
    case 'project':
      return bare(str(record, 'name')) || null;
    case 'certification':
      return certificationIdentity(str(record, 'name'), str(record, 'issuer')) || null;
    case 'education':
      return educationIdentity(str(record, 'institution'), str(record, 'credential'), str(record, 'field')) || null;
    case 'volunteering':
      return `${bare(str(record, 'organization'))}:${bare(str(record, 'role'))}`.replace(/^:$/, '') || null;
    case 'award':
    case 'achievement':
    case 'publication':
    case 'writing':
      return bare(str(record, 'title')) || null;
    case 'language':
    case 'interest':
      return bare(str(record, 'name')) || null;
    default:
      return null;
  }
}

/**
 * Which copy to keep: the one that says the most.
 *
 * A record the user approved beats a proposal, one they typed beats one a parser wrote,
 * and — the part that actually matters on a resume — a copy carrying a date, an issuer or
 * a result beats a bare title.
 */
function keepScore(record: StewardRecord): number {
  const filled = Object.values(record.data).filter((v) =>
    Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim().length > 0 : v != null,
  ).length;
  const text = JSON.stringify(record.data ?? {});
  return (
    filled * 3 +
    (record.reviewState === 'approved' ? 2 : 0) +
    (record.source === 'manual' ? 1 : 0) +
    Math.min(text.length, 600) / 1000
  );
}

const LABELS: Record<string, string> = {
  project: 'project',
  certification: 'certification',
  education: 'qualification',
  award: 'award',
  achievement: 'achievement',
  publication: 'publication',
  writing: 'article',
  volunteering: 'role',
  language: 'language',
  interest: 'interest',
};

/**
 * One merge suggestion per group of copies. `describe` comes from the caller so this stays
 * free of the forms registry and can be tested on its own.
 */
export function duplicateRecords(
  records: StewardRecord[],
  describe: (record: StewardRecord) => string,
  sectionOf: (type: string) => Suggestion['section'],
): Draft[] {
  const groups = new Map<string, StewardRecord[]>();
  for (const record of records) {
    if (record.reviewState === 'rejected') continue;
    const key = duplicateKey(record);
    if (!key) continue;
    const bucket = `${record.type}:${key}`;
    groups.set(bucket, [...(groups.get(bucket) ?? []), record]);
  }

  const out: Draft[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort((a, b) => keepScore(b) - keepScore(a));
    const noun = LABELS[keep.type] ?? 'entry';
    out.push({
      kind: 'merge',
      section: sectionOf(keep.type),
      recordId: keep.id,
      recordType: keep.type,
      label: describe(keep),
      title: `Remove ${rest.length} duplicate ${noun}${rest.length === 1 ? '' : 's'} of “${describe(keep)}”`,
      reason:
        rest.length === 1
          ? `The same ${noun} is stored twice, so it prints twice on every resume.`
          : `The same ${noun} is stored ${group.length} times, so it prints ${group.length} times on every resume.`,
      origin: 'rule',
      quick: false,
      removeIds: rest.map((r) => r.id),
      basis: Object.fromEntries(group.map((r) => [r.id, r.contentHash])),
    });
  }
  return out;
}
