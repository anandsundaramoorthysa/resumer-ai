/**
 * Skills-section completeness — REQ-5.2 (weight 0.40, the heaviest sub-score).
 *
 * Measures one specific thing: of the job's required keywords that the user GENUINELY
 * HAS somewhere in their profile, how many made it into the dedicated Skills section?
 *
 * The "genuinely has" qualifier is what keeps this honest. A keyword the user does not
 * possess is not counted against them here — that's a real gap, reported by the loop's
 * halt path (REQ-5.5), never something the system tries to close by inventing content.
 */

import type { ProfileRecord, ResumeDocument } from '../types';
import { holdsKeyword, textHoldsKeyword } from './vocabulary';
import { canonicalSkillName, skillAliases } from '../skills/identity';

export interface SkillsCompletenessResult {
  score: number; // 0..1
  /** Keywords the user has, that belong in Skills, but aren't there yet — fixable. */
  missingButHeld: string[];
  /** Keywords the user genuinely lacks — NOT fixable by rewriting (REQ-5.5). */
  genuineGaps: string[];
  present: string[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Everything the profile can legitimately claim, as a normalized set.
 *
 * Each term is added under its own spelling *and* its canonical one (AUDIT #11), so a
 * profile that says "React.js" still evidences a posting that says "React". This is
 * additive on purpose: the alias table only ever states that two spellings are the same
 * skill, so widening the vocabulary this way cannot manufacture a claim the profile does
 * not already make — which is the one thing this set must never do (NFR-8).
 */
export function profileVocabulary(records: ProfileRecord[]): Set<string> {
  const vocab = new Set<string>();
  const add = (term: string) => {
    const n = norm(term);
    if (!n) return;
    vocab.add(n);
    vocab.add(norm(canonicalSkillName(term)));
  };
  for (const r of records) {
    for (const tag of r.tags) add(tag);
    if (r.type === 'skill') add(r.name);
    if (r.type === 'project') for (const s of r.stack) add(s);
  }
  return vocab;
}

/**
 * The keyword, plus every other spelling of the same skill. A posting writing "Node.js"
 * and a Skills line writing "Node" are one keyword, and only the alias table knows it.
 */
function spellings(keyword: string): string[] {
  return [keyword, ...skillAliases(keyword)];
}

export function scoreSkillsCompleteness(
  doc: ResumeDocument,
  records: ProfileRecord[],
): SkillsCompletenessResult {
  const keywords = doc.jobRequirement?.atsKeywords ?? [];
  if (keywords.length === 0) {
    return { score: 1, missingButHeld: [], genuineGaps: [], present: [] };
  }

  const vocab = profileVocabulary(records);
  const skillsSection = doc.sections.find((s) => s.key === 'skills');
  const skillsText = norm(
    (skillsSection?.items ?? []).map((i) => i.text).join(' , '),
  );

  const present: string[] = [];
  const missingButHeld: string[] = [];
  const genuineGaps: string[] = [];

  for (const kw of keywords) {
    // Whole-phrase, one-directional matching (see vocabulary.ts). Substring matching
    // here previously let a profile containing "SEO" claim "technical SEO".
    const inSkills = spellings(kw).some((s) => textHoldsKeyword(skillsText, s));
    const held = spellings(kw).some((s) => holdsKeyword(vocab, s));

    // Present only if the profile holds it too. A Skills section that lists a posting's
    // terms the candidate does not have is stuffing, not coverage: it must not earn credit
    // (and it is a gap, not a fixable omission).
    if (inSkills && held) present.push(kw);
    else if (held) missingButHeld.push(kw);
    else genuineGaps.push(kw);
  }

  // Denominator is only what the user actually has — you cannot lose points for not
  // possessing a skill, only for failing to surface one you do possess. But a candidate who
  // holds none of the posting's skills scores 0, not a free 1.0 (anti-stuffing).
  const claimable = present.length + missingButHeld.length;
  const score = claimable === 0 ? 0 : present.length / claimable;

  return { score, missingButHeld, genuineGaps, present };
}
