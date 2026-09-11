/**
 * Display tidying for resume text — the last pass before a document becomes a file.
 *
 * Profile records hold what the user, an importer or a model wrote, and none of those
 * reliably start a sentence with a capital or keep one fact from being printed twice. A
 * generated resume printed "M.Sc. Data Science · Data Science" because the degree name
 * already carried its field, and the assembler joined both. Nothing here changes a
 * record; it changes only how a line reads, so it is safe to run on any document,
 * including one the user has since edited by hand.
 *
 * Skill names are cased elsewhere (`canonicalSkillName` in lib/skills/identity.ts),
 * because a skill is a name and a bullet is a sentence, and the two need opposite rules.
 */

import type { ResumeDocument, ResumeSection } from '../types';
import { rendersAsPlainLine } from '../render/sections';
import { canonicalSkillName } from '../skills/identity';

/**
 * Capitalises the first letter of a bullet or description that starts lowercase.
 *
 * Conservative on purpose — the text is the user's, and a wrong "correction" is worse
 * than none:
 *   - Only a first word written entirely in lowercase letters is touched. "iOS app for",
 *     "eBay listings", "jQuery plugin" carry a capital already, so their casing is chosen.
 *   - A first word the skill table knows as lowercase by convention stays lowercase:
 *     "pandas pipeline that", "npm package for". npm's own style guide keeps it lowercase
 *     even at the start of a sentence, and a data-science reader sees "Pandas" as a typo.
 *   - Everything after the first letter is left alone. Sentence case is not applied to
 *     the rest, because the rest is where product names live.
 */
export function capitaliseFirst(text: string): string {
  // The lookahead is what keeps "iOS" whole: without it the match stops at "i".
  const firstWord = /^[a-z][a-z-]*(?![A-Za-z0-9])/.exec(text)?.[0];
  if (!firstWord) return text;
  const known = canonicalSkillName(firstWord);
  if (/^[a-z]/.test(known)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Drops a part already said by an earlier one, as a whole phrase.
 *
 * "M.Sc. Data Science" then field "Data Science" printed the field twice on one line —
 * a repeat a recruiter reads as a template filled in without looking. Only the later part
 * is ever dropped, and only when an earlier part contains all of it on word boundaries,
 * so a longer institution name that happens to include the field
 * ("Institute of Computer Science") is never the thing that goes.
 */
export function withoutRepeatedParts(parts: Array<string | undefined>): string[] {
  const kept: string[] = [];
  for (const raw of parts) {
    const part = raw?.trim();
    if (!part) continue;
    const needle = new RegExp(`(^|\\W)${escapeRegExp(part.toLowerCase())}(\\W|$)`);
    if (kept.some((k) => needle.test(k.toLowerCase()))) continue;
    kept.push(part);
  }
  return kept;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The document with every sentence-shaped line starting on a capital.
 *
 * Joined-line sections (Skills, Languages, Interests) are skipped: they are lists of
 * names, where the first letter belongs to a name — "pandas, NumPy" must not become
 * "Pandas, NumPy". The summary is prose, so it is included despite rendering as a plain
 * line. Group titles and subtitles are names too and are left alone.
 */
export function tidyResumeText(doc: ResumeDocument): ResumeDocument {
  const tidy = (s: ResumeSection): ResumeSection => {
    if (rendersAsPlainLine(s.key) && s.key !== 'summary') return s;
    return {
      ...s,
      items: s.items.map((i) => ({ ...i, text: capitaliseFirst(i.text) })),
      ...(s.groups
        ? {
            groups: s.groups.map((g) => ({
              ...g,
              items: g.items.map((i) => ({ ...i, text: capitaliseFirst(i.text) })),
            })),
          }
        : {}),
    };
  };
  return { ...doc, sections: doc.sections.map(tidy) };
}
