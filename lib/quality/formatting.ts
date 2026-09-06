/**
 * Formatting compliance — REQ-5.2 (weight 0.30), enforcing REQ-6.1's ats-strict rules.
 *
 * Fully deterministic. Every rule here maps to a mechanical parsing failure mode, not
 * to style preference — which is why the loop is never allowed to "argue" its way past
 * one: these either hold or they don't.
 */

import type { ResumeDocument } from '../types';
import { isAllowedHeading } from '../render/headings';
import { containsNumericDate } from '../render/dates';

export interface FormattingViolation {
  rule: string;
  detail: string;
  sectionKey?: string;
}

export interface FormattingResult {
  score: number; // 0..1
  violations: FormattingViolation[];
}

/** Characters that render as boxes/? or get skipped by parsers (REQ-6.1). */
const DISALLOWED_BULLET_CHARS = /[►◆★➤▪▸●■◦‣⁃✦✧✱❖]/u;

/** Private-use-area + dingbats — the classic icon-font glyph failure. */
const ICON_GLYPH_PATTERN = /[-✀-➿️]|\p{Extended_Pictographic}/u;

/** Tab/pipe-heavy lines suggest a table or column layout leaked into content. */
const TABULAR_PATTERN = /\t|(\|\s*\S+\s*\|)/;

export function scoreFormatting(doc: ResumeDocument): FormattingResult {
  const violations: FormattingViolation[] = [];

  // --- Headings must come from the allow-list (REQ-6.1) -----------------------
  for (const section of doc.sections) {
    if (!isAllowedHeading(section.key, section.heading)) {
      violations.push({
        rule: 'heading-allow-list',
        detail: `"${section.heading}" is not an approved heading for the ${section.key} section.`,
        sectionKey: section.key,
      });
    }
  }

  // --- A dedicated Skills section is non-negotiable ---------------------------
  const skillsSection = doc.sections.find((s) => s.key === 'skills');
  if (!skillsSection || skillsSection.items.length === 0) {
    violations.push({
      rule: 'skills-section-required',
      detail:
        'No dedicated Skills section. Parsers weight terms found there more heavily than the same term inside a bullet.',
    });
  }

  // --- The document must actually contain a resume ----------------------------
  //
  // Observed live: an over-aggressive relevance floor left a document holding one
  // certification and nothing else, and it scored 9.7/10 because every rule it was
  // measured against happened to hold. Formatting compliance means nothing on a page
  // with no substance, so emptiness is itself a formatting failure.
  const substantiveLines = doc.sections
    .filter((s) => s.key === 'experience' || s.key === 'projects' || s.key === 'summary')
    .reduce(
      (n, s) => n + s.items.length + (s.groups ?? []).reduce((m, g) => m + g.items.length, 0),
      0,
    );

  if (substantiveLines === 0) {
    violations.push({
      rule: 'has-substance',
      detail:
        'The resume has no experience, projects or summary content — there is nothing here for a recruiter or a parser to read.',
    });
  }

  // --- Contact block must be present in the body ------------------------------
  if (!doc.contact?.fullName?.trim() || !doc.contact?.email?.trim()) {
    violations.push({
      rule: 'contact-in-body',
      detail:
        'Name and email must both be present in the document body (never a header/footer region).',
    });
  }

  // --- Hyperlink visible text must be the actual URL --------------------------
  for (const [label, url] of [
    ['portfolio', doc.contact?.portfolioUrl],
    ['github', doc.contact?.githubUrl],
    ['linkedin', doc.contact?.linkedinUrl],
  ] as const) {
    if (url && !/[a-z0-9-]+\.[a-z]{2,}/i.test(url)) {
      violations.push({
        rule: 'hyperlink-visible-text',
        detail: `The ${label} link's visible text must be the readable URL itself, not a label.`,
      });
    }
  }

  // --- Per-line content rules -------------------------------------------------
  for (const section of doc.sections) {
    const lines: Array<{ text: string; where: string }> = [];
    for (const item of section.items) lines.push({ text: item.text, where: section.key });
    for (const group of section.groups ?? []) {
      lines.push({ text: group.title, where: section.key });
      if (group.dateRange) lines.push({ text: group.dateRange, where: section.key });
      for (const item of group.items) lines.push({ text: item.text, where: section.key });
    }

    for (const { text, where } of lines) {
      if (ICON_GLYPH_PATTERN.test(text)) {
        violations.push({
          rule: 'no-icon-glyphs',
          detail: `Icon/emoji glyph found in "${truncate(text)}" — these extract as boxes or vanish entirely.`,
          sectionKey: where,
        });
      }
      if (DISALLOWED_BULLET_CHARS.test(text)) {
        violations.push({
          rule: 'plain-bullet-chars',
          detail: `Decorative bullet character in "${truncate(text)}" — use a plain • or -.`,
          sectionKey: where,
        });
      }
      if (containsNumericDate(text)) {
        violations.push({
          rule: 'spelled-out-dates',
          detail: `Numeric date in "${truncate(text)}" — locale-ambiguous; use "Jan 2022" form.`,
          sectionKey: where,
        });
      }
      if (TABULAR_PATTERN.test(text)) {
        violations.push({
          rule: 'no-tabular-layout',
          detail: `Tab or pipe-table structure in "${truncate(text)}" — scrambles reading order.`,
          sectionKey: where,
        });
      }
    }
  }

  // --- Presentation mode may never be the ats-strict target -------------------
  if (doc.renderMode === 'presentation') {
    violations.push({
      rule: 'presentation-mode-not-for-ats',
      detail:
        'This document is in presentation mode (icons allowed) and must not be scored as an ATS submission.',
    });
  }

  // Score: each distinct violated RULE costs equally, so one repeated mistake does
  // not dominate the score more than a different single mistake.
  const distinctRules = new Set(violations.map((v) => v.rule)).size;
  const TOTAL_RULES = 10;
  const score = Math.max(0, (TOTAL_RULES - distinctRules) / TOTAL_RULES);

  return { score, violations };
}

function truncate(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
