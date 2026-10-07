/**
 * Anti-fabrication guard — NFR-8 / REQ-4.4.
 *
 * The prompt tells the model not to invent things. This module verifies it didn't,
 * because a prompt is a request and this is a guarantee. Any quantity, or any proper noun,
 * that appears in a rewritten bullet but not in its source is a violation, and the rewrite
 * is rejected in favour of the original text.
 *
 * Deliberately conservative: when in doubt, keep the user's own words.
 *
 * What the checks compare, and why each is not a substring test:
 *
 *   - TEXT is canonicalised on both sides first (`canon`): NFKC, zero-width characters
 *     removed, full-width digits folded, Cyrillic/Greek look-alikes of Latin letters folded.
 *     Without it "４０%" and "Кubernetes" (Cyrillic K) were new text that matched nothing.
 *   - ENTITIES are matched as whole tokens (Unicode-aware; + # . _ stay in the token, so
 *     C++, C#, .NET and Node.js are single names). A substring test let "Java" pass against
 *     "JavaScript", "SQL" against "PostgreSQL", "Git" against "GitHub", "Spring" against
 *     "Springer".
 *   - QUANTITIES are compared as (dimension, value), where the dimension is plain, percent,
 *     multiple ("3x") or a currency, and scale words fold into the value (lakh, crore, k,
 *     m, bn, million …). "₹10 crore" is 10^8 rupees and "₹10 lakh" 10^6, so they differ;
 *     "40M" is not "40%"; "1,00,000" = "100000" = "1 lakh" = "100k". Number WORDS
 *     (ten, tripling, half …) are quantities too.
 */

import { keywordMatches, normalizeForMatch } from '../quality/keywords';
import { DICTIONARY_TERMS } from '../skills/dictionary';
import { skillIdentity } from '../skills/identity';

/** Words that are capitalized for grammar, not because they're proper nouns. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'built', 'by', 'delivered', 'designed', 'developed',
  'drove', 'for', 'from', 'implemented', 'improved', 'in', 'increased', 'into', 'led',
  'launched', 'managed', 'of', 'on', 'optimized', 'or', 'owned', 'reduced', 'shipped',
  'the', 'to', 'with', 'using', 'across', 'built', 'created', 'the', 'their', 'this',
]);

/* ------------------------------------------------------------ canonical text -- */

/** Cyrillic and Greek letters that are drawn like a Latin letter. */
const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
  І: 'I', Ј: 'J', Ѕ: 'S', Ү: 'Y',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd',
  һ: 'h', ԛ: 'q', ԝ: 'w', ӏ: 'l',
  // Greek
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P',
  Τ: 'T', Υ: 'Y', Χ: 'X',
  ο: 'o', ν: 'v', ι: 'i', ρ: 'p', α: 'a', κ: 'k', τ: 't', υ: 'u', χ: 'x',
  // Latin look-alikes NFKC leaves alone
  ı: 'i', ɡ: 'g', ǀ: 'l',
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');
const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

/** The one spelling every comparison in this file is made on. Idempotent. */
export function canon(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c] ?? c)
    .replace(/[\u2010\u2011\u2012\u2212]/g, '-');
}

function normalizeToken(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}\p{M}+#.]/gu, '');
}

/* ------------------------------------------------------------------ quantities -- */

type Dimension = 'plain' | 'pct' | 'x' | 'inr' | 'usd' | 'eur' | 'gbp';

interface Quantity {
  dim: Dimension;
  value: number;
  /** As written, lowercased with spaces and thousands separators removed. */
  display: string;
  /** True when the writer used lakh/crore, which only ever mean rupees. */
  indianScale: boolean;
}

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3, thousands: 1e3,
  m: 1e6, mn: 1e6, mm: 1e6, million: 1e6, millions: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5,
  crore: 1e7, crores: 1e7, cr: 1e7,
};

const CURRENCY_PREFIX: Record<string, Dimension> = {
  '₹': 'inr', rs: 'inr', inr: 'inr', $: 'usd', usd: 'usd', us$: 'usd', '€': 'eur', eur: 'eur', '£': 'gbp', gbp: 'gbp',
};
const CURRENCY_WORD: Record<string, Dimension> = {
  rupee: 'inr', rupees: 'inr', inr: 'inr', rs: 'inr', dollar: 'usd', dollars: 'usd', usd: 'usd',
  euro: 'eur', euros: 'eur', eur: 'eur', pound: 'gbp', pounds: 'gbp', gbp: 'gbp',
};

// Indian grouping (1,00,000) and Western (1,000,000) both: a comma group of 2 or 3 digits.
const NUM = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const QUANTITY_RE = new RegExp(
  String.raw`(?<![\d])(?:(₹|us\$|\$|€|£|\brs\.?|\binr|\busd|\beur|\bgbp)\s?)?(${NUM})` +
    // scale: single letters only when attached ("5m", never "5 more"); words may be spaced
    String.raw`(?:(?:\s?(lakhs?|lacs?|crores?|thousand|millions?|billions?|mn|bn|cr)|([kmb]))(?![\p{L}\p{N}]))?` +
    // dimension
    String.raw`(?:\s?(%|percent(?:age)?(?:\s+points?)?|per\s?cent|pct)|(x|×)(?![\p{L}\p{N}])|\s(times)(?![\p{L}\p{N}]))?` +
    // a currency word after the figure ("1.2 million dollars", "5 lakh rupees")
    String.raw`(?:\s(rupees?|dollars?|euros?|pounds?|usd|inr|eur|gbp)(?![\p{L}\p{N}]))?\+?`,
  'giu',
);

function parseValue(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

/** Every numeric quantity in `text`, with its dimension. `text` must already be canonical. */
function numericQuantities(text: string): { quantities: Quantity[]; rest: string } {
  const quantities: Quantity[] = [];
  const rest = text.replace(QUANTITY_RE, (whole, cur, num, scaleWord, scaleLetter, pct, mult, times, curWord) => {
    const scaleKey = String(scaleWord ?? scaleLetter ?? '').toLowerCase();
    const scale = scaleKey ? SCALE[scaleKey] ?? 1 : 1;
    let dim: Dimension = 'plain';
    if (pct) dim = 'pct';
    else if (mult || times) dim = 'x';
    else if (cur) dim = CURRENCY_PREFIX[String(cur).toLowerCase().replace(/\.$/, '')] ?? 'plain';
    else if (curWord) dim = CURRENCY_WORD[String(curWord).toLowerCase()] ?? 'plain';
    const value = parseValue(num) * scale;
    if (!Number.isFinite(value)) return ' ';
    quantities.push({
      dim,
      value,
      // Thousands separators are kept: callers print this token back at the user.
      display: whole.replace(/\s+/g, '').replace(/[.,]+$/, '').toLowerCase(),
      indianScale: scaleKey in INDIAN_SCALE,
    });
    return ' ';
  });
  return { quantities, rest };
}

const INDIAN_SCALE: Record<string, true> = { lakh: true, lakhs: true, lac: true, lacs: true, crore: true, crores: true, cr: true };

/**
 * Number words. `value`/`dim` are what the word asserts, so "tripling" is grounded by "3x"
 * and "ten teams" by "10 teams". "one" is left out of idioms ("one-on-one", "no one").
 */
const NUMBER_WORDS: Record<string, { value: number; dim: Dimension }> = {
  one: { value: 1, dim: 'plain' }, two: { value: 2, dim: 'plain' }, three: { value: 3, dim: 'plain' },
  four: { value: 4, dim: 'plain' }, five: { value: 5, dim: 'plain' }, six: { value: 6, dim: 'plain' },
  seven: { value: 7, dim: 'plain' }, eight: { value: 8, dim: 'plain' }, nine: { value: 9, dim: 'plain' },
  ten: { value: 10, dim: 'plain' }, eleven: { value: 11, dim: 'plain' }, twelve: { value: 12, dim: 'plain' },
  thirteen: { value: 13, dim: 'plain' }, fourteen: { value: 14, dim: 'plain' }, fifteen: { value: 15, dim: 'plain' },
  sixteen: { value: 16, dim: 'plain' }, seventeen: { value: 17, dim: 'plain' }, eighteen: { value: 18, dim: 'plain' },
  nineteen: { value: 19, dim: 'plain' }, twenty: { value: 20, dim: 'plain' }, thirty: { value: 30, dim: 'plain' },
  forty: { value: 40, dim: 'plain' }, fifty: { value: 50, dim: 'plain' }, sixty: { value: 60, dim: 'plain' },
  seventy: { value: 70, dim: 'plain' }, eighty: { value: 80, dim: 'plain' }, ninety: { value: 90, dim: 'plain' },
  dozen: { value: 12, dim: 'plain' }, dozens: { value: 12, dim: 'plain' },
  hundred: { value: 100, dim: 'plain' }, hundreds: { value: 100, dim: 'plain' },
  thousand: { value: 1e3, dim: 'plain' }, thousands: { value: 1e3, dim: 'plain' },
  million: { value: 1e6, dim: 'plain' }, millions: { value: 1e6, dim: 'plain' },
  billion: { value: 1e9, dim: 'plain' }, billions: { value: 1e9, dim: 'plain' },
  lakh: { value: 1e5, dim: 'plain' }, lakhs: { value: 1e5, dim: 'plain' },
  crore: { value: 1e7, dim: 'plain' }, crores: { value: 1e7, dim: 'plain' },
  twice: { value: 2, dim: 'x' }, double: { value: 2, dim: 'x' }, doubled: { value: 2, dim: 'x' }, doubling: { value: 2, dim: 'x' },
  triple: { value: 3, dim: 'x' }, tripled: { value: 3, dim: 'x' }, tripling: { value: 3, dim: 'x' },
  quadruple: { value: 4, dim: 'x' }, quadrupled: { value: 4, dim: 'x' }, quadrupling: { value: 4, dim: 'x' },
  half: { value: 50, dim: 'pct' },
};
const NUMBER_WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(${Object.keys(NUMBER_WORDS).join('|')})(?![\\p{L}\\p{N}\\p{M}_])`, 'giu');
const ONE_IDIOM = /\bone(?:-|\s+(?:of|another|on|day|time|stop|click|by|size|way)\b)|\b(?:no|any|every|each|some)\s+one\b|\bone\s+(?:and\s+the\s+same|or\s+more)\b/i;

function wordQuantities(rest: string): Quantity[] {
  const out: Quantity[] = [];
  for (const m of rest.matchAll(NUMBER_WORD_RE)) {
    const word = m[1].toLowerCase();
    if (word === 'one') {
      // look at the words around this one, not the whole text
      const from = Math.max(0, (m.index ?? 0) - 6);
      if (ONE_IDIOM.test(rest.slice(from, (m.index ?? 0) + 24))) continue;
    }
    const w = NUMBER_WORDS[word];
    out.push({ dim: w.dim, value: w.value, display: word, indianScale: word.startsWith('lakh') || word.startsWith('crore') });
  }
  return out;
}

function allQuantities(text: string): { numeric: Quantity[]; words: Quantity[] } {
  const { quantities, rest } = numericQuantities(canon(text));
  return { numeric: quantities, words: wordQuantities(rest) };
}

/** Numbers, percentages, currency, and multipliers — anything written in digits. */
export function extractNumbers(text: string): string[] {
  return numericQuantities(canon(text)).quantities.map((q) => q.display).filter((d) => d.length > 0);
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Whether the source states a quantity this one is entitled to. */
function quantityGrounded(q: Quantity, source: readonly Quantity[]): boolean {
  return source.some((s) => {
    if (!close(s.value, q.value)) return false;
    if (s.dim === q.dim) return true;
    // Claiming LESS than the source ("$5" written "5") is fine; adding a currency is not —
    // except lakh/crore, which are rupees whether or not the sign is printed.
    if (q.dim === 'plain' && s.dim !== 'pct' && s.dim !== 'x') return true;
    if (q.dim === 'inr' && s.dim === 'plain' && s.indianScale) return true;
    return false;
  });
}

/* ------------------------------------------------------------------- entities -- */

/**
 * Tokenisation shared by extraction and matching. Hyphens and dashes split too:
 * "Python-driven" is the name "Python" plus an ordinary word, and checked whole it became
 * "pythondriven" — a name no profile contains. Curly quotes too: "EA’s" is "EA".
 */
function splitTokens(text: string): string[] {
  return text.split(/[\s,;:()[\]"'‘’“”\-\u2010\u2011–—!?]+/).filter(Boolean);
}

/** Capitalized tokens that look like product/tool/company names. */
export function extractProperNouns(text: string): string[] {
  const tokens = splitTokens(canon(text));
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i].replace(/[.]+$/, '');
    if (!raw) continue;
    const isCapitalized = /^\p{Lu}/u.test(raw) || /\p{Lu}{2,}/u.test(raw);
    const hasTechShape = /[.+#/]/.test(raw) && /\p{L}/u.test(raw); // Node.js, C++, CI/CD
    if (!isCapitalized && !hasTechShape) continue;
    const n = normalizeToken(raw);
    if (!n || n.length < 2) continue;
    if (STOPWORDS.has(n)) continue;
    // Skip the first word of the sentence unless it's clearly a tech token.
    // A capital that only marks the start of a sentence is not a name. The first word was
    // always exempt; every sentence start is now, because a multi-sentence summary had
    // "Proven …" and "Ready …" refused as entities the profile never mentioned.
    const sentenceStart = i === 0 || /[.!?]$/.test(tokens[i - 1]);
    if (sentenceStart && !hasTechShape && !/\p{Lu}{2,}/u.test(raw)) continue;
    out.push(n);
  }
  return out;
}

/**
 * Every spelling a token may be known by: itself, without dots ("Next.js" / "NextJS"),
 * its curated skill identity ("Postgres" / "PostgreSQL", "Node" / "Node.js"), and its
 * singular/plural. A match on any key is a match — and nothing here is a prefix or
 * substring rule, which is the whole point.
 */
function entityKeys(token: string): string[] {
  const keys = new Set<string>();
  const add = (t: string) => {
    if (!t) return;
    keys.add(t);
    keys.add(t.replace(/\./g, ''));
    if (t.length >= 4 && t.endsWith('s')) keys.add(t.slice(0, -1));
    else if (t.length >= 3) keys.add(`${t}s`);
  };
  add(token);
  add(skillIdentity(token).replace(/[^\p{L}\p{N}\p{M}+#.]/gu, ''));
  return [...keys];
}

/** Every token of `text` (and adjacent pairs joined: "D2R AI" -> "d2rai"), as match keys. */
function sourceKeySet(text: string): Set<string> {
  const keys = new Set<string>();
  const raws = splitTokens(canon(text)).map((t) => t.replace(/[.]+$/, ''));
  const tokens = raws.map(normalizeToken);
  raws.forEach((raw, i) => {
    // "CI/CD" is one name and also the two it joins.
    const parts = raw.includes('/') ? [raw, ...raw.split('/')] : [raw];
    for (const p of parts) for (const k of entityKeys(normalizeToken(p))) keys.add(k);
    const next = tokens[i + 1];
    if (tokens[i] && next) for (const k of entityKeys(tokens[i] + next)) keys.add(k);
  });
  return keys;
}

const entityInSource = (entity: string, sourceKeys: Set<string>): boolean =>
  entityKeys(entity).some((k) => sourceKeys.has(k));

/**
 * Names written in lower case. The capital-letter heuristic cannot see "at google" or
 * "kubernetes", so these are recognised by lexicon: the skills dictionary plus well-known
 * employers. Ordinary English words that are also tool names ("react", "excel", "make",
 * "spring") are excluded — a capital makes those entities, lower case does not.
 */
const AMBIGUOUS_TERMS = new Set([
  'react', 'express', 'spring', 'rust', 'ruby', 'swift', 'dart', 'make', 'render', 'segment',
  'dash', 'less', 'lean', 'neon', 'crystal', 'ember', 'phoenix', 'chef', 'puppet', 'zoom',
  'unity', 'sanity', 'resend', 'clerk', 'bun', 'nim', 'gin', 'nats', 'moz', 'koa', 'bash',
  'sketch', 'notion', 'slack', 'amplitude', 'sentry', 'looker', 'excel', 'flask', 'apache',
  'canva', 'railway', 'chroma', 'poetry', 'eclipse', 'parcel', 'rollup', 'babel', 'vim',
  'emacs', 'scheme', 'lisp', 'assembly', 'shell', 'regex', 'less', 'moment', 'gatsby',
  'remix', 'astro', 'apollo', 'athena', 'blender', 'insomnia', 'swagger', 'curl', 'confluence',
  'trello', 'asana', 'monday', 'segment', 'reflex', 'qt', 'ionic', 'lodash', 'axios', 'dash',
  'version', 'control', 'content', 'message', 'queue', 'vector', 'database', 'management',
  'system', 'payment', 'gateways', 'data', 'lake', 'cloud', 'google', 'microsoft', 'amazon',
  'oracle', 'sap', 'apple', 'meta', 'stripe', 'engine', 'studio', 'code', 'visual', 'api',
  'rest', 'websockets', 'android', 'windows', 'server', 'app', 'run', 'functions', 'search',
  'workspace', 'analytics', 'tag', 'manager', 'console', 'forms', 'sheets', 'testing',
  'library', 'query', 'react', 'node', 'prettier', 'vagrant', 'prefect', 'illustrator',
  'replicate', 'angular', 'transformers', 'electron', 'bootstrap', 'leaflet', 'cypress',
  'playwright', 'mocha', 'chai', 'jest', 'flutter', 'celery', 'pinecone', 'yarn', 'selenium',
  'azure', 'prisma', 'snowflake', 'anaconda', 'photoshop',
]);

const COMPANIES = [
  'google', 'microsoft', 'amazon', 'meta', 'facebook', 'apple', 'netflix', 'uber', 'tcs',
  'infosys', 'wipro', 'accenture', 'deloitte', 'ibm', 'oracle', 'flipkart', 'swiggy',
  'zomato', 'paytm', 'phonepe', 'openai', 'anthropic', 'nvidia', 'tesla', 'adobe', 'cisco',
  'intel', 'samsung', 'walmart', 'mckinsey', 'cognizant', 'hcl', 'capgemini', 'zoho',
  'atlassian', 'linkedin', 'twitter', 'spotify', 'airbnb', 'goldman', 'jpmorgan', 'pwc',
  'kpmg', 'bcg', 'byjus', 'ola', 'razorpay',
];
/** Common English words that are also employers: only a name after at/for/with/@. */
const CONTEXTUAL_COMPANIES = new Set(['apple', 'meta', 'amazon', 'oracle', 'google', 'microsoft', 'ola', 'uber', 'intel', 'tesla', 'adobe']);
const COMPANY_CONTEXT = new RegExp(
  `(?:(?<![\\p{L}\\p{N}])(?:at|for|with|joined|from|@)\\s*)(${[...CONTEXTUAL_COMPANIES].join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

const LEXICON: Set<string> = (() => {
  const set = new Set<string>();
  for (const term of DICTIONARY_TERMS) {
    if (/\s/.test(term)) continue;
    const t = normalizeToken(term);
    if (t.length >= 3 && !AMBIGUOUS_TERMS.has(t)) set.add(t);
  }
  for (const extra of ['hadoop', 'kubeflow', 'mlflow']) set.add(extra);
  for (const c of COMPANIES) if (!CONTEXTUAL_COMPANIES.has(c) && !AMBIGUOUS_TERMS.has(c)) set.add(c);
  return set;
})();

/** Names in `text` that the lexicon knows, however they are cased. */
function lexiconNames(text: string): string[] {
  const canonical = canon(text);
  const found = new Set<string>();
  for (const raw of splitTokens(canonical)) {
    const t = normalizeToken(raw.replace(/[.]+$/, ''));
    if (LEXICON.has(t)) found.add(t);
  }
  for (const m of canonical.matchAll(COMPANY_CONTEXT)) found.add(m[1].toLowerCase());
  return [...found];
}

/** Letters of scripts with no upper case: a name there cannot be spotted by a capital. */
const CASELESS_RUN_RE =
  /[\p{Script=Devanagari}\p{Script=Tamil}\p{Script=Bengali}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}]+/gu;
const SPACELESS_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

function caselessRuns(text: string): string[] {
  return canon(text).match(CASELESS_RUN_RE) ?? [];
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
  candidate = canon(candidate);
  source = canon(source);

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
  const violations: GroundingViolation[] = [];
  const seen = new Set<string>();
  const push = (kind: GroundingViolation['kind'], token: string) => {
    const id = `${kind}:${token}`;
    if (seen.has(id)) return;
    seen.add(id);
    violations.push({ kind, token });
  };

  const cand = allQuantities(candidate);
  const src = allQuantities(source);
  // A figure may be grounded by a digit form or a word form of the same value.
  const sourceQuantities = [...src.numeric, ...src.words];

  for (const q of cand.numeric) {
    if (!quantityGrounded(q, sourceQuantities)) push('number', q.display);
  }
  for (const q of cand.words) {
    if (!quantityGrounded(q, sourceQuantities)) push('number', q.display);
  }

  const sourceKeys = sourceKeySet(source);

  for (const entity of extractProperNouns(candidate)) {
    if (!entityInSource(entity, sourceKeys)) push('entity', entity);
  }
  // Lower-case names ("at google", "kubernetes") that no capital gives away.
  for (const name of lexiconNames(candidate)) {
    if (!entityInSource(name, sourceKeys)) push('entity', name);
  }
  // Names in scripts with no capitals (Devanagari, Tamil, CJK …): a run the source does
  // not contain is a name the profile never mentioned.
  const sourceRuns = new Set(caselessRuns(source));
  const sourceCanon = canon(source);
  for (const run of caselessRuns(candidate)) {
    const present = SPACELESS_RE.test(run) ? sourceCanon.includes(run) : sourceRuns.has(run);
    if (!present) push('entity', run.length > 40 ? run.slice(0, 40) : run);
  }

  // The posting's lowercase terms. The checks above only see figures and names, and the
  // model is shown the posting's keyword list while it writes, so a skill written in lower
  // case walked straight through: on the EA analyst posting the bullet "Integrated
  // open-source AI models into web applications using Flask" came back as "Integrated
  // predictive modeling AI models…", "understand their market" became "define business
  // questions", and the summary claimed "time-series forecasting … to support
  // experimentation" — none of it in the profile, all of it counted by the 70% keyword
  // gate. Matched with the gate's own matcher, so what is refused here is exactly what the
  // gate would have credited.
  if (postingTerms.length > 0) {
    const candNorm = normalizeForMatch(candidate);
    const srcNorm = normalizeForMatch(source);
    for (const term of postingTerms) {
      if (keywordMatches(candNorm, term) && !keywordMatches(srcNorm, term)) {
        push('keyword', term);
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
