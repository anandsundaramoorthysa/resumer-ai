/**
 * Does the profile actually hold a given keyword? — NFR-8.
 *
 * This is the single most consequential comparison in the app. Everything else can be
 * wrong and produce a mediocre resume; getting THIS wrong produces a resume that claims
 * skills the person does not have, which is the one outcome the whole design exists to
 * prevent.
 *
 * The bug this replaces: both call sites tested `keyword.includes(profileTerm)` as well
 * as the reverse. That direction is never evidence of anything — a profile containing
 * "SEO" would claim "technical SEO", and one containing "dev" would claim "developers".
 * Observed live: a generated resume listed "developers" as a skill, plus eight SEO tools
 * the profile had no exact entry for.
 *
 * The rule now runs one way only. The profile may be MORE specific than the keyword
 * ("Advanced Technical SEO" holds "technical SEO"), never less ("SEO" does not hold
 * "technical SEO"). Matching is on whole words, so "Java" cannot hold "JavaScript".
 */

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-phrase containment: `haystack` contains `needle` on word boundaries.
 *
 * Every occurrence is tried, not only the first. Checking just the first meant a needle
 * that first appears inside a longer word was never found at all: "postgresql and sql"
 * did not contain "sql", and a Skills row "Programming Languages: Python, R" did not
 * contain "R", because the first "r" is in "programming". Every caller — the keyword
 * gate, the skills scorer, retrieval — then counted a term the text states outright as
 * missing, depending only on what happened to be printed before it.
 */
export function containsPhrase(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  if (!needle) return false;

  const boundary = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}]/u.test(c);
  for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + 1)) {
    if (boundary(haystack[idx - 1]) && boundary(haystack[idx + needle.length])) return true;
  }
  return false;
}

function wordCount(s: string): number {
  return s.split(' ').filter(Boolean).length;
}

/**
 * How much longer a profile entry may be than the keyword it's vouching for.
 *
 * Containment alone is not enough, because tags are derived from free text: the
 * certification "ChatGPT Prompt Engineering for Developers" contains the word
 * "developers", and on that basis a real generated resume listed "developers" as a
 * skill. A credential's title is not evidence of every word inside it.
 *
 * A genuinely more-specific entry stays close in length ("Advanced Technical SEO" for
 * "technical SEO"); a title that merely happens to contain the word does not.
 */
const MAX_EXTRA_WORDS = 2;

/**
 * True only when something in the profile genuinely evidences this keyword.
 * Deliberately conservative: a false negative costs a point of score, while a false
 * positive puts a claim on a resume that the person cannot back up in an interview.
 */
export function holdsKeyword(vocabulary: Iterable<string>, keyword: string): boolean {
  const k = normalize(keyword);
  if (!k) return false;

  for (const raw of vocabulary) {
    const v = normalize(raw);
    if (!v) continue;
    if (v === k) return true;
    // The profile entry may be more specific than the keyword, never less — and only
    // slightly more specific, so a long free-text title cannot vouch for a word it
    // merely contains.
    if (wordCount(v) - wordCount(k) <= MAX_EXTRA_WORDS && containsPhrase(v, k)) {
      return true;
    }
  }
  return false;
}

/** Same rule, applied to a block of text such as the rendered Skills line. */
export function textHoldsKeyword(text: string, keyword: string): boolean {
  const k = normalize(keyword);
  if (!k) return false;
  return containsPhrase(normalize(text), k);
}
