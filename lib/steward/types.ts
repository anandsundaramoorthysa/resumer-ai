/**
 * The shapes the profile steward trades in — STEWARD.md §3, layer 2.
 *
 * Pure types and two pure helpers, importable from the browser: the suggestion list is
 * rendered by a client component, and the same fingerprint function has to run where the
 * suggestion is made and where it is dismissed.
 */

export type StewardSection = 'skills' | 'experience' | 'projects' | 'credentials' | 'other';

export const STEWARD_SECTIONS: Array<{ id: StewardSection; label: string }> = [
  { id: 'skills', label: 'Skills' },
  { id: 'experience', label: 'Experience' },
  { id: 'projects', label: 'Projects' },
  { id: 'credentials', label: 'Education and certifications' },
  { id: 'other', label: 'Everything else' },
];

export function sectionOf(type: string): StewardSection {
  switch (type) {
    case 'skill':
      return 'skills';
    case 'experience-bullet':
    case 'role':
      return 'experience';
    case 'project':
      return 'projects';
    case 'education':
    case 'certification':
      return 'credentials';
    default:
      return 'other';
  }
}

/** A profile record as the steward reads it: the row, with its fields under `data`. */
export interface StewardRecord {
  id: string;
  type: string;
  source: string;
  reviewState: string;
  contentHash: string;
  data: Record<string, unknown>;
}

export interface StewardRole {
  id: string;
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  reviewState: string;
}

export interface StewardProfile {
  records: StewardRecord[];
  roles: StewardRole[];
}

export type SuggestionKind = 'fix' | 'merge' | 'move' | 'remove' | 'ask';

/**
 * One proposed change. Nothing here is applied until the user says so.
 *
 *   fix     `changes` holds field → { from, to } for one record.
 *   merge   `recordId` is kept; `removeIds` are the same thing and go.
 *   move    the record becomes `moveTo.type` with `moveTo.data`; `ask`, when present, is a
 *           required field the new type needs and only the user can supply.
 *   remove  the record adds nothing and goes.
 *   ask     a fact is missing; the user's answer is stored verbatim in `ask.field`.
 */
export interface Suggestion {
  /** Stable fingerprint of the proposal against the record's current content. */
  id: string;
  kind: SuggestionKind;
  section: StewardSection;
  /** The record the suggestion is about — a role id when `recordType` is 'role'. */
  recordId: string;
  recordType: string;
  /** What the record is, for the reader: "Skill · ML". */
  label: string;
  /** What to do, in a few words: "Merge into Machine Learning". */
  title: string;
  /** Why, in one sentence. */
  reason: string;
  origin: 'rule' | 'ai';
  /** Safe to apply in bulk without reading: typography and casing that change no fact. */
  quick: boolean;
  changes?: Record<string, { from: unknown; to: unknown }>;
  removeIds?: string[];
  moveTo?: { type: string; data: Record<string, unknown> };
  ask?: { field: string; prompt: string; placeholder?: string };
  /**
   * recordId → contentHash when the suggestion was made. Applying refuses if any of them
   * has changed since, instead of writing a proposal over an edit it never saw.
   */
  basis: Record<string, string>;
}

/** FNV-1a, hex. Not security: a short, stable key that runs in the browser and in Node. */
export function fingerprint(parts: unknown[]): string {
  const text = JSON.stringify(parts);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The fingerprint of a suggestion: what it proposes, against which versions of what. */
export function suggestionId(s: Omit<Suggestion, 'id'>): string {
  return fingerprint([
    s.kind,
    s.recordId,
    s.basis,
    s.changes ? Object.entries(s.changes).map(([k, v]) => [k, v.to]) : null,
    s.removeIds ?? null,
    s.moveTo?.type ?? null,
    s.ask?.field ?? null,
  ]);
}
