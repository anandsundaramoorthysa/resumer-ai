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
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    // Marks are kept (Indic vowel signs are \p{M}) and so is "&": "R&D" must stay one
    // token, or the short-keyword rule in containsPhrase never sees the ampersand.
    .replace(/[^\p{L}\p{N}\p{M}+#.&\s-]/gu, ' ')
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

  const boundary = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}\p{M}]/u.test(c);
  const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}\p{M}]/u.test(c);
  // A very short keyword ("R", "Go", "C", "Net") is a word only when nothing glues it to
  // its neighbour. Punctuation alone is not a boundary: "R" is inside "R&D", "Go" inside
  // "go-to-market", "C" inside "C++"/"C#", "Net" inside "ASP.NET". The gate counted all
  // four as the skill.
  const short = needle.length <= 2 && /^[\p{L}\p{N}\p{M}]+$/u.test(needle);
  const dotted = needle.length === 3 && /^[\p{L}\p{N}]+$/u.test(needle);
  // A hyphen joins "AI-powered" to a genuine "AI", so it only disqualifies keywords that
  // are also ordinary words ("go-to-market", "it-works"); & # + . disqualify any short one.
  const GLUE = needle.length === 1 || /^(go|it|be|do|my|no|so|me)$/.test(needle) ? /[&#+.-]/ : /[&#+.]/;
  for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + 1)) {
    const before = haystack[idx - 1];
    const after = haystack[idx + needle.length];
    if (!boundary(before) || !boundary(after)) continue;
    if (short) {
      // "c++" / "c#": the sign itself continues the name.
      if (after !== undefined && /[+#]/.test(after)) continue;
      if (after !== undefined && GLUE.test(after) && isWord(haystack[idx + needle.length + 1])) continue;
      if (before !== undefined && GLUE.test(before) && isWord(haystack[idx - 2])) continue;
    } else if (dotted && before === '.' && isWord(haystack[idx - 2])) {
      continue; // "asp.net", "vb.net": a namespace suffix, not the word on its own
    }
    return true;
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
