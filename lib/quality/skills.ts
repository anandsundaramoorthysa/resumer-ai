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

/** Everything the profile can legitimately claim, as a normalized set. */
export function profileVocabulary(records: ProfileRecord[]): Set<string> {
  const vocab = new Set<string>();
  for (const r of records) {
    for (const tag of r.tags) vocab.add(norm(tag));
    if (r.type === 'skill') vocab.add(norm(r.name));
    if (r.type === 'project') for (const s of r.stack) vocab.add(norm(s));
  }
  return vocab;
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
    const k = norm(kw);
    // Whole-phrase, one-directional matching (see vocabulary.ts). Substring matching
    // here previously let a profile containing "SEO" claim "technical SEO".
    const inSkills = textHoldsKeyword(skillsText, kw);
    const held = holdsKeyword(vocab, kw);

    if (inSkills) present.push(kw);
    else if (held) missingButHeld.push(kw);
    else genuineGaps.push(kw);
  }

  // Denominator is only what the user actually has — you cannot lose points for not
  // possessing a skill, only for failing to surface one you do possess.
  const claimable = present.length + missingButHeld.length;
  const score = claimable === 0 ? 1 : present.length / claimable;

  return { score, missingButHeld, genuineGaps, present };
}
