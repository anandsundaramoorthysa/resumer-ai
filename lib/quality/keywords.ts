/**
 * Keyword coverage — REQ-5.1.
 *
 * A pass/fail GATE at 70%, not a weighted component. The plan's own philosophy is that
 * keyword-stuffed bullets without evidence score worse, not better; weighting coverage
 * heavily would push the loop toward exactly that anti-pattern. So coverage is a floor
 * to clear, and the actual score comes from formatting/evidence/skills.
 *
 * Fully deterministic — no model call, no hallucination surface.
 */

import type { ResumeDocument } from '../types';
import { containsPhrase } from './vocabulary';
import { skillAliases } from '../skills/identity';

export const KEYWORD_GATE_THRESHOLD = 0.7;

/** Normalizes for comparison: lowercase, strip punctuation, collapse whitespace. */
function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    // Marks and "&" survive: see normalize() in vocabulary.ts.
    .replace(/[^\p{L}\p{N}\p{M}+#.&\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-word match, with narrow spelling variance.
 *
 * The previous version's comment claimed "React" must not match "reacts to" — while the
 * code did exactly that, testing raw substring containment AND generating a `${k}s`
 * plural, so "React" matched "reacts" by construction. Since this feeds the gate that
 * decides whether a resume is good enough to ship, that inflated the one number the
 * whole quality claim rests on.
 *
 * Now every comparison is on word boundaries (shared with vocabulary.ts, so the gate and
 * the skills scorer agree). Variance is kept for genuine spelling differences —
 * "CI/CD" vs "ci cd", "Node.js" vs "nodejs".
 *
 * Plurals need both directions to be useful — a posting saying "integration" should
 * match "integrations" in the text, and vice versa. But adding an "s" is what produced
 * the original defect: "React" became "reacts" and matched "the service reacts to
 * webhook events".
 *
 * The distinction is that React is a product name. A common noun pluralises into
 * another common noun ("integration" -> "integrations", still about integrations),
 * whereas a proper noun plus an "s" usually lands on an unrelated verb. So pluralising
 * is allowed for ordinary words and withheld from anything the posting capitalised or
 * wrote with a dot or digit — the shape of a technology name.
 */
const MIN_PLURAL_STEM = 4;

/** Product/technology names: capitalised, or carrying a version or dotted namespace. */
function looksLikeProperNoun(rawKeyword: string): boolean {
  const first = rawKeyword.trim()[0] ?? '';
  return /[A-Z]/.test(first) || /[.\d]/.test(rawKeyword);
}

function matches(haystack: string, keyword: string): boolean {
  const k = norm(keyword);
  if (!k) return false;
  if (containsPhrase(haystack, k)) return true;

  const variants = new Set<string>([
    k.replace(/\s+/g, '-'),
    k.replace(/-/g, ' '),
    k.replace(/\./g, ''),
    k.replace(/\//g, ' '),
    // Other spellings of the same skill (AUDIT #11). The mechanical variants above only
    // reach differences in punctuation, so a posting asking for "Golang" against a resume
    // saying "Go" counted as a miss and cost the 70% gate a keyword it genuinely had.
    // These come from a curated table, never from a similarity rule — see skills/identity.
    ...skillAliases(keyword),
  ]);

  const lastWord = k.split(' ').pop() ?? '';
  if (lastWord.length >= MIN_PLURAL_STEM) {
    if (k.endsWith('s')) {
      // Stripping is always safe: the worst case is a missed match.
      variants.add(k.slice(0, -1));
    } else if (!looksLikeProperNoun(keyword)) {
      variants.add(`${k}s`);
    }
  }

  for (const v of variants) {
    if (v.length > 1 && v !== k && containsPhrase(haystack, v)) return true;
  }
  return false;
}

/**
 * The gate's own matcher, for code that has to agree with it.
 *
 * The fit assessment (lib/fit/assess.ts) answers "does this profile hold what the posting
 * asks for?" and the page trim (lib/generate/fit-page.ts) answers "would dropping this
 * line lose a keyword?". Both questions are only worth asking if they are answered by the
 * same rule the 70% gate uses — a second, looser matcher would tell someone they hold a
 * skill the gate then says is missing. So this is the same function, exported, rather than
 * a copy.
 *
 * `haystack` must already be normalised with `normalizeForMatch`.
 */
export function keywordMatches(haystack: string, keyword: string): boolean {
  return matches(haystack, keyword);
}

/** The normalisation every haystack passed to `keywordMatches` needs. */
export function normalizeForMatch(text: string): string {
  return norm(text);
}

export interface KeywordCoverage {
  passed: boolean;
  coveragePct: number;
  matched: string[];
  missing: string[];
}

/** Flattens every rendered string in the document into one searchable corpus. */
export function documentText(doc: ResumeDocument): string {
  const parts: string[] = [];
  for (const section of doc.sections) {
    parts.push(section.heading);
    for (const item of section.items) parts.push(item.text);
    for (const group of section.groups ?? []) {
      parts.push(group.title, group.subtitle ?? '');
      for (const item of group.items) parts.push(item.text);
    }
  }
  return norm(parts.join(' \n '));
}

export function scoreKeywordCoverage(doc: ResumeDocument): KeywordCoverage {
  const keywords = doc.jobRequirement?.atsKeywords ?? [];
  if (keywords.length === 0) {
    // Baseline resume (REQ-6.7) has no job to match against — the gate is vacuous.
    return { passed: true, coveragePct: 1, matched: [], missing: [] };
  }

  const corpus = documentText(doc);
  const matched: string[] = [];
  const missing: string[] = [];

  for (const kw of keywords) {
    if (matches(corpus, kw)) matched.push(kw);
    else missing.push(kw);
  }

  const coveragePct = matched.length / keywords.length;
  return {
    passed: coveragePct >= KEYWORD_GATE_THRESHOLD,
    coveragePct,
    matched,
    missing,
  };
}
