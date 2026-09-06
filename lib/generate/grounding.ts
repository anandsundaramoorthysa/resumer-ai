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
  const tokens = text.split(/[\s,;:()[\]"']+/).filter(Boolean);
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
    if (i === 0 && !hasTechShape && !/[A-Z]{2,}/.test(raw)) continue;
    out.push(n);
  }
  return out;
}

export interface GroundingViolation {
  kind: 'number' | 'entity';
  token: string;
}

/**
 * Returns the tokens present in `candidate` but absent from `source`.
 * Empty array == the rewrite introduced nothing new.
 */
export function findUngroundedTokens(
  candidate: string,
  source: string,
): GroundingViolation[] {
  const sourceNorm = source.toLowerCase();
  const sourceNumbers = new Set(extractNumbers(source));
  const sourceEntities = new Set(extractProperNouns(source));

  const violations: GroundingViolation[] = [];

  for (const num of extractNumbers(candidate)) {
    if (sourceNumbers.has(num)) continue;
    // Allow a number that appears verbatim in the source string in any form.
    if (sourceNorm.includes(num.replace(/[%kmbx+]/g, ''))) continue;
    violations.push({ kind: 'number', token: num });
  }

  for (const entity of extractProperNouns(candidate)) {
    if (sourceEntities.has(entity)) continue;
    if (sourceNorm.includes(entity)) continue;
    violations.push({ kind: 'entity', token: entity });
  }

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
): { text: string; accepted: boolean; violations: GroundingViolation[] } {
  const violations = findUngroundedTokens(candidate, source);
  if (violations.length === 0 && candidate.trim().length > 0) {
    return { text: candidate.trim(), accepted: true, violations };
  }
  return { text: source, accepted: false, violations };
}
