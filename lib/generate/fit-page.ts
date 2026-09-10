/**
 * Making the draft fit the page, by removing what the posting cares least about.
 *
 * The assembler's own page budget (`fitToBudget` in ./assemble.ts) only ever drops whole
 * tail sections — Interests, Languages, Volunteering. It never trims Projects,
 * Certifications or older roles, so a large profile goes straight past the page: both EA
 * drafts from a 170-record profile came out at 50 content lines against a 29-line page,
 * the length rule failed on every one, and formatting was capped at 91% before anything
 * else was judged. No revision pass could fix it, because revision rewrites lines; it
 * never removes them.
 *
 * This removes them, one unit at a time, until the scorer's own length check
 * (`lengthVerdict` in ../quality/length.ts) stops saying "long" — the same measure the
 * gate applies, so the two cannot disagree. The order is what makes it safe:
 *
 *   - a unit whose removal loses no job keyword goes before one that does, always;
 *   - among equals, the least important section goes first (the category's own section
 *     order, read from the bottom), and within a section the last item, because retrieval
 *     already ranked items by relevance;
 *   - Summary, Skills and Education are never touched, a role always keeps two bullets,
 *     and nothing is removed that would make the resume too SHORT.
 *
 * Pure — no model, no randomness — and applied twice: straight after assembly, so the
 * first draft fits, and by the revision pass when a length critique still stands.
 */

import type { ResumeDocument, SectionKey } from '../types';
import { lengthVerdict } from '../quality/length';
import { scoreKeywordCoverage } from '../quality/keywords';

const PROTECTED: ReadonlySet<SectionKey> = new Set(['summary', 'skills', 'education']);
const MIN_BULLETS_KEPT_PER_ROLE = 2;
/** Far more removals than any real document needs; a guard, not a budget. */
const MAX_REMOVALS = 80;

export interface TrimResult {
  document: ResumeDocument;
  /** Human-readable, for the draft note: `project "Data Pipeline"`. */
  removed: string[];
}

interface Candidate {
  label: string;
  apply: (doc: ResumeDocument) => ResumeDocument;
}

export function trimToPage(input: ResumeDocument): TrimResult {
  if (!input.jobRequirement || lengthVerdict(input) !== 'long') {
    return { document: input, removed: [] };
  }

  let doc = input;
  const removed: string[] = [];

  for (let n = 0; n < MAX_REMOVALS && lengthVerdict(doc) === 'long'; n++) {
    const baseline = scoreKeywordCoverage(doc).matched.length;
    let chosen: { candidate: Candidate; next: ResumeDocument; loss: number } | null = null;

    // Candidates arrive least-important first, so the first one that loses nothing is the
    // right one, and the search can stop there.
    for (const candidate of removalCandidates(doc)) {
      const next = candidate.apply(doc);
      if (lengthVerdict(next) === 'short') continue;
      const loss = baseline - scoreKeywordCoverage(next).matched.length;
      if (!chosen || loss < chosen.loss) chosen = { candidate, next, loss };
      if (loss === 0) break;
    }

    if (!chosen) break;
    doc = chosen.next;
    removed.push(chosen.candidate.label);
  }

  return { document: doc, removed };
}

/** Every removable unit, least important first. */
function removalCandidates(doc: ResumeDocument): Candidate[] {
  const out: Candidate[] = [];

  // From the bottom of the page up: the section order is the category's ranking of what
  // matters, so the last section is the one this role can best afford to lose.
  for (let s = doc.sections.length - 1; s >= 0; s--) {
    const section = doc.sections[s];
    if (PROTECTED.has(section.key)) continue;

    if (section.key === 'experience') {
      // Oldest role first, its last bullet first — and never below the floor per role.
      const groups = section.groups ?? [];
      for (let g = groups.length - 1; g >= 0; g--) {
        const group = groups[g];
        for (let i = group.items.length - 1; i >= MIN_BULLETS_KEPT_PER_ROLE; i--) {
          out.push({
            label: `a bullet under ${group.title}`,
            apply: (d) => edit(d, s, (sec) => sec.groups![g].items.splice(i, 1)),
          });
        }
      }
      continue;
    }

    // Grouped sections (Projects) lose whole groups: half a project is worse than none.
    const groups = section.groups ?? [];
    for (let g = groups.length - 1; g >= 0; g--) {
      out.push({
        label: `${singular(section.key)} "${groups[g].title}"`,
        apply: (d) => edit(d, s, (sec) => sec.groups!.splice(g, 1)),
      });
    }

    for (let i = section.items.length - 1; i >= 0; i--) {
      const text = section.items[i].text;
      out.push({
        label: `${singular(section.key)} "${text.length > 40 ? `${text.slice(0, 39)}…` : text}"`,
        apply: (d) => edit(d, s, (sec) => sec.items.splice(i, 1)),
      });
    }
  }

  return out;
}

/** Applies a removal to a copy, then drops any group or section it left empty. */
function edit(
  doc: ResumeDocument,
  sectionIndex: number,
  mutate: (section: ResumeDocument['sections'][number]) => void,
): ResumeDocument {
  const next = structuredClone(doc);
  mutate(next.sections[sectionIndex]);
  const section = next.sections[sectionIndex];
  if (section.groups) section.groups = section.groups.filter((g) => g.items.length > 0 || g.title);
  const empty = section.items.length === 0 && (section.groups?.length ?? 0) === 0;
  if (empty) next.sections.splice(sectionIndex, 1);
  return next;
}

function singular(key: SectionKey): string {
  switch (key) {
    case 'projects':
      return 'project';
    case 'certifications':
      return 'certification';
    case 'achievements':
      return 'achievement';
    case 'publications':
      return 'publication';
    case 'awards':
      return 'award';
    default:
      return `${key} item`;
  }
}
