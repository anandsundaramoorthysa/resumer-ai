/**
 * Anti-fabrication guard — NFR-8 / REQ-4.4.
 *
 * The prompt tells the model not to invent things. This module verifies it didn't,
 * because a prompt is a request and this is a guarantee. Any number, or any capitalized
 * proper noun, that appears in a rewritten bullet but not in its source is a violation,
 * and the rewrite is rejected in favour of the original text.
 *
 * Deliberately conservative: when in doubt, keep the user's own words.
 */

import { keywordMatches, normalizeForMatch } from '../quality/keywords';

/** Words that are capitalized for grammar, not because they're proper nouns. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'built', 'by', 'delivered', 'designed', 'developed',
  'drove', 'for', 'from', 'implemented', 'improved', 'in', 'increased', 'into', 'led',
  'launched', 'managed', 'of', 'on', 'optimized', 'or', 'owned', 'reduced', 'shipped',
  'the', 'to', 'with', 'using', 'across', 'built', 'created', 'the', 'their', 'this',
]);

function normalizeToken(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}+#.]/gu, '');
}

/** Numbers, percentages, currency, and multipliers — anything quantitative. */
export function extractNumbers(text: string): string[] {
  const matches = text.match(/\d[\d,.]*\s*(?:%|k|m|b|x|\+)?/gi) ?? [];
  return matches
    .map((m) => m.replace(/\s+/g, '').toLowerCase().replace(/[.,]+$/, ''))
    .filter((m) => m.length > 0);
}

/** Capitalized tokens that look like product/tool/company names. */
export function extractProperNouns(text: string): string[] {
  // Hyphens and dashes split too: "Python-driven" is the name "Python" plus an ordinary
  // word, and checked whole it became "pythondriven" — a name no profile contains.
  // Curly quotes too: "EA’s" was checked whole as the name "eas".
  const tokens = text.split(/[\s,;:()[\]"'‘’“”\-‐‑–—]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i].replace(/[.]+$/, '');
    if (!raw) continue;
    const isCapitalized = /^[A-Z]/.test(raw) || /[A-Z]{2,}/.test(raw);
    const hasTechShape = /[.+#/]/.test(raw) && /[a-zA-Z]/.test(raw); // Node.js, C++, CI/CD
    if (!isCapitalized && !hasTechShape) continue;
    const n = normalizeToken(raw);
    if (!n || n.length < 2) continue;
    if (STOPWORDS.has(n)) continue;
    // Skip the first word of the sentence unless it's clearly a tech token.
    // A capital that only marks the start of a sentence is not a name. The first word was
    // always exempt; every sentence start is now, because a multi-sentence summary had
    // "Proven …" and "Ready …" refused as entities the profile never mentioned.
    const sentenceStart = i === 0 || /[.!?]$/.test(tokens[i - 1]);
    if (sentenceStart && !hasTechShape && !/[A-Z]{2,}/.test(raw)) continue;
    out.push(n);
  }
  return out;
}

export interface GroundingViolation {
  kind: 'number' | 'entity' | 'keyword' | 'scope';
  token: string;
}

/**
 * Words that say the work was shared, or somebody else's to begin with.
 *
 * "Helped clients build a dashboard" is a different claim from "Built a dashboard for
 * clients", and the second is the one a rewrite reaches for. Numbers and names are
 * unchanged by that edit, so the checks above see nothing: the fabrication is in the verb.
 */
const HEDGES = [
  'helped', 'assisted', 'supported', 'contributed to', 'participated in', 'collaborated on',
  'collaborated with', 'shadowed', 'observed', 'was part of', 'were part of', 'part of a team',
  'under the guidance', 'under guidance', 'learning', 'learned', 'studied', 'explored',
];

/** Longer than any one bullet: past this, the source is a corpus, not the same claim. */
const SINGLE_CLAIM_CHARS = 400;

/** Verbs that claim the work was the writer's to direct. */
const OWNERSHIP = [
  'led', 'leading', 'owned', 'owning', 'managed', 'managing', 'spearheaded', 'headed',
  'directed', 'oversaw', 'overseeing', 'supervised', 'founded', 'architected', 'mentored',
  'coached', 'drove', 'driving', 'established', 'pioneered', 'orchestrated',
];

const saysAny = (text: string, phrases: readonly string[]): string | null => {
  for (const phrase of phrases) {
    if (new RegExp(`(?:^|[^\\p{L}])${phrase.replace(/ /g, '\\s+')}(?![\\p{L}])`, 'iu').test(text)) return phrase;
  }
  return null;
};

/**
 * Whether the rewrite claims more of the work than the source did — NFR-8 applied to the
 * verb rather than the nouns.
 *
 * Two ways that happens: the source hedged and the rewrite dropped the hedge, or the
 * rewrite added a word of ownership the source never used. Both are refused, and the
 * user's own sentence is printed instead.
 */
export function findScopeInflation(candidate: string, source: string): GroundingViolation[] {
  const out: GroundingViolation[] = [];

  // The hedge half only makes sense when the source IS this claim — a rewritten bullet
  // against the bullet it came from. A summary is checked against the whole profile, where
  // some other line saying "helped" would delete every sentence: measured, it removed the
  // entire summary from the EA draft. Ownership is checked either way, because claiming
  // "Led" when nothing in the profile says so is a fabrication at any length.
  const singleClaim = source.length <= SINGLE_CLAIM_CHARS;
  const hedged = singleClaim ? saysAny(source, HEDGES) : null;
  if (hedged && !saysAny(candidate, HEDGES)) out.push({ kind: 'scope', token: hedged });

  const claimed = saysAny(candidate, OWNERSHIP);
  if (claimed && !saysAny(source, OWNERSHIP)) out.push({ kind: 'scope', token: claimed });

  return out;
}

/** Strips the unit so "40%", "40k" and "40" compare as the same figure. */
function bareFigure(token: string): string {
  return token.replace(/[%kmbx+]/g, '');
}

/**
 * Whether `figure` occurs in the source as a whole number rather than as a fragment of a
 * longer one.
 *
 * The digit-boundary check is not decoration. Matching by plain substring let an
 * invented "9x" through because the source happened to mention "p95" — measured at 7
 * escapes in 1,439 generated fabrications (tests/grounding.test.mts). A guard that leaks
 * one fabrication in two hundred is not a guarantee, and a guarantee is what NFR-8 says
 * this is.
 */
function containsFigure(source: string, figure: string): boolean {
  if (!figure) return false;
  const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A trailing sentence period is not a decimal point, so only a following digit — or a
  // period that is itself followed by one — means the match landed inside a longer figure.
  return new RegExp(`(?<![\\d.])${escaped}(?!\\d)(?!\\.\\d)`).test(source);
}

/**
 * Returns the tokens present in `candidate` but absent from `source`.
 * Empty array == the rewrite introduced nothing new.
 */
export function findUngroundedTokens(
  candidate: string,
  source: string,
  /**
   * The posting's own keywords. A rewrite may not add one its source does not already
   * match — see the loop at the end of this function.
   */
  postingTerms: readonly string[] = [],
): GroundingViolation[] {
  const sourceNorm = source.toLowerCase();
  const sourceNumbers = new Set(extractNumbers(source));
  const sourceEntities = new Set(extractProperNouns(source));

  const violations: GroundingViolation[] = [];

  // The same figure written with a different unit ("40%" vs "40 percent") is the same
  // claim, so units are stripped before comparing — but the comparison is still against
  // whole figures the source actually states, never against any run of digits inside one.
  const sourceFigures = new Set([...sourceNumbers].map(bareFigure));

  for (const num of extractNumbers(candidate)) {
    if (sourceNumbers.has(num)) continue;
    const bare = bareFigure(num);
    if (sourceFigures.has(bare)) continue;
    if (containsFigure(sourceNorm, bare)) continue;
    violations.push({ kind: 'number', token: num });
  }

  for (const entity of extractProperNouns(candidate)) {
    if (sourceEntities.has(entity)) continue;
    if (sourceNorm.includes(entity)) continue;
    violations.push({ kind: 'entity', token: entity });
  }

  // The posting's lowercase terms. The two checks above only see figures and capitalised
  // names, and the model is shown the posting's keyword list while it writes, so a skill
  // written in lower case walked straight through: on the EA analyst posting the bullet
  // "Integrated open-source AI models into web applications using Flask" came back as
  // "Integrated predictive modeling AI models…", "understand their market" became "define
  // business questions", and the summary claimed "time-series forecasting … to support
  // experimentation" — none of it in the profile, all of it counted by the 70% keyword
  // gate. Matched with the gate's own matcher, so what is refused here is exactly what the
  // gate would have credited.
  if (postingTerms.length > 0) {
    const cand = normalizeForMatch(candidate);
    const src = normalizeForMatch(source);
    for (const term of postingTerms) {
      if (keywordMatches(cand, term) && !keywordMatches(src, term)) {
        violations.push({ kind: 'keyword', token: term });
      }
    }
  }

  violations.push(...findScopeInflation(candidate, source));

  return violations;
}

export function isGrounded(candidate: string, source: string): boolean {
  return findUngroundedTokens(candidate, source).length === 0;
}

/**
 * Accept a rewrite only if it introduces nothing new; otherwise fall back to the
 * original. This is the enforcement point for NFR-8 — a model that ignores the
 * instruction simply doesn't get its output used.
 */
export function acceptRewriteOrFallback(
  candidate: string,
  source: string,
  postingTerms: readonly string[] = [],
): { text: string; accepted: boolean; violations: GroundingViolation[] } {
  const violations = findUngroundedTokens(candidate, source, postingTerms);
  if (violations.length === 0 && candidate.trim().length > 0) {
    return { text: candidate.trim(), accepted: true, violations };
  }
  return { text: source, accepted: false, violations };
}
