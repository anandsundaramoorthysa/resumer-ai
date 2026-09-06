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

export const KEYWORD_GATE_THRESHOLD = 0.7;

/** Normalizes for comparison: lowercase, strip punctuation, collapse whitespace. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tolerant match: exact substring, or singular/plural and common suffix variance.
 * Deliberately NOT fuzzy-by-edit-distance — "React" should not match "reacts to" by
 * accident, and a false positive here inflates the score dishonestly.
 */
function matches(haystack: string, keyword: string): boolean {
  const k = norm(keyword);
  if (!k) return false;
  if (haystack.includes(k)) return true;

  // Plural / possessive variance
  const variants = [
    k.endsWith('s') ? k.slice(0, -1) : `${k}s`,
    k.replace(/\s+/g, '-'),
    k.replace(/-/g, ' '),
    k.replace(/\./g, ''),
  ];
  return variants.some((v) => v.length > 1 && haystack.includes(v));
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
