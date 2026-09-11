/**
 * What kind of thing a skill is — the classifier, in layers, cheapest first.
 *
 * The five original categories (language, framework, tool, platform, soft-skill) had no
 * home for a technique, so every parser filed Machine Learning as a "framework",
 * Statistics as a "tool" and Web Development as a "soft-skill". `method` is that home:
 * something you know how to do, rather than a thing you install, import or write in.
 *
 * Three layers run here, in order, and stop at the first confident answer:
 *
 *   1. the dictionary (./dictionary.ts) — 650 named skills, looked up through the alias
 *      table so every spelling lands on one entry. Certain.
 *   2. the same dictionary through variants of the name: the acronym in "Natural Language
 *      Processing (NLP)", the expansion of "ML", the singular of "Vector Databases", the
 *      head of "RAG pipelines", each half of "Emacs / Org Mode". Certain.
 *   3. shape rules — "… API" is a platform, "… Development" a method, "….js" a framework.
 *      Likely rather than certain, and marked so.
 *
 * A name none of them recognises gets no answer at all, which is the safe outcome: the
 * caller keeps whatever category it had. A fourth layer, for exactly those names, lives in
 * ./classify-ai.ts — one model call, cached for every user, never in a save path.
 */

import { skillIdentity } from './identity';
import { dictionaryCategory } from './dictionary';

export type SkillCategory = 'language' | 'framework' | 'tool' | 'platform' | 'method' | 'soft-skill';

export const SKILL_CATEGORIES: SkillCategory[] = [
  'language',
  'framework',
  'tool',
  'platform',
  'method',
  'soft-skill',
];

export function isSkillCategory(value: unknown): value is SkillCategory {
  return typeof value === 'string' && (SKILL_CATEGORIES as string[]).includes(value);
}

export const SKILL_CATEGORY_LABELS: Record<SkillCategory, string> = {
  language: 'languages',
  framework: 'frameworks and libraries',
  tool: 'tools',
  platform: 'platforms and services',
  method: 'methods and disciplines',
  'soft-skill': 'soft skills',
};

/**
 * Short forms with exactly one meaning on a resume. Shared with lib/steward/rules.ts,
 * which uses the same expansions to see that "ML" and "Machine Learning" are one skill.
 */
export const ACRONYMS: Record<string, string> = {
  ml: 'machine learning',
  ai: 'artificial intelligence',
  agi: 'artificial general intelligence',
  nlp: 'natural language processing',
  nlu: 'natural language understanding',
  llm: 'large language model',
  dl: 'deep learning',
  cv: 'computer vision',
  rl: 'reinforcement learning',
  seo: 'search engine optimization',
  sem: 'search engine marketing',
  cms: 'content management system',
  crm: 'customer relationship management',
  ocr: 'optical character recognition',
  cnn: 'convolutional neural network',
  rnn: 'recurrent neural network',
  gan: 'generative adversarial network',
  rag: 'retrieval augmented generation',
  eda: 'exploratory data analysis',
  oop: 'object oriented programming',
  dsa: 'data structures and algorithms',
  tdd: 'test driven development',
  bdd: 'behavior driven development',
  iac: 'infrastructure as code',
  sre: 'site reliability engineering',
  api: 'application programming interface',
  ui: 'user interface',
  ux: 'user experience',
  qa: 'quality assurance',
  etl: 'extract transform load',
  bi: 'business intelligence',
  pca: 'principal component analysis',
};

/** "databases" → "database"; leaves "analysis", "class" and "status" alone. */
function singular(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

const wordsOf = (name: string) =>
  name.toLowerCase().replace(/[^\p{L}\p{N}+#./]+/gu, ' ').split(' ').filter(Boolean);

/**
 * Words that qualify a skill without changing what kind of thing it is: "RAG pipelines" is
 * RAG, "Agentic AI Development" is agentic AI. Stripping them is what lets the dictionary
 * answer for phrases nobody would list individually.
 */
const QUALIFIERS = new Set([
  'pipeline', 'pipelines', 'workflow', 'workflows', 'system', 'systems', 'technique',
  'techniques', 'model', 'models', 'framework', 'frameworks', 'library', 'libraries',
  'tool', 'tools', 'technology', 'technologies', 'stack', 'basics', 'fundamentals',
  'concepts', 'principles', 'practices', 'skills', 'experience', 'knowledge',
]);

/** Every reading of a name worth trying against the dictionary, most faithful first. */
export function nameVariants(name: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(name);

  // "Natural Language Processing (NLP)" is both of its halves.
  const paren = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(name.trim());
  if (paren) {
    push(paren[1]);
    push(paren[2]);
  }
  // "Emacs / Org Mode", "AI/ML", "React & Redux" name two things; either identifies it.
  for (const part of name.split(/\s*[/&]\s*|\s+and\s+/i)) if (part.trim().length > 1) push(part);

  for (const base of [...out]) {
    const words = wordsOf(base);
    if (words.length === 0) continue;
    // The words in the singular, and the acronym spelled out — in both orders, because
    // "LLMs" is only "large language model" once the plural is off the acronym.
    const singles = words.map(singular);
    push(singles.join(' '));
    push(words.map((w) => ACRONYMS[w] ?? w).join(' '));
    push(singles.map((w) => ACRONYMS[w] ?? w).join(' '));
    push(singles.map((w) => ACRONYMS[w] ?? w).map(singular).join(' '));
    // The phrase without its qualifying tail: "RAG pipelines" → "RAG".
    const trimmed = words.filter((w) => !QUALIFIERS.has(singular(w)));
    if (trimmed.length > 0 && trimmed.length < words.length) {
      push(trimmed.join(' '));
      push(trimmed.map((w) => ACRONYMS[w] ?? w).join(' '));
    }
  }
  return out;
}

/**
 * Shape rules for names no dictionary will ever list — a company's internal tool, a new
 * library, a discipline written in the writer's own words. Ordered: the first match wins,
 * so the most specific endings come first.
 */
const PATTERNS: Array<[RegExp, SkillCategory]> = [
  [/\bapi\b\s*$|\bapis\b\s*$|\bsdk\b\s*$|\bgateway(s)?\s*$/i, 'platform'],
  [/\b(development|engineering|design|analysis|analytics|modelling|modeling|optimi[sz]ation|management|testing|research|marketing|writing|forecasting|automation|administration|architecture)\s*$/i, 'method'],
  [/\.(js|ts|py|rb|net)\s*$|\bjs\s*$/i, 'framework'],
  [/\b(cloud|database|db|warehouse|server|hosting|platform|service|suite|studio|hub|bot api)\s*$/i, 'platform'],
  [/\b(scripting|programming|language)\s*$/i, 'language'],
  [/\b(learning|network(s)?|algorithm(s)?|statistic(s)?|regression|classification|clustering|segmentation|visuali[sz]ation|intelligence|processing|recognition|detection|generation|search|methodology|practice(s)?)\s*$/i, 'method'],
  [/\b(ide|editor|cli|tracker|dashboard|profiler|linter|compiler|debugger)\s*$/i, 'tool'],
  [/\b(communication|collaboration|leadership|teamwork|mindset|ethic|empathy|listening|speaking)\b/i, 'soft-skill'],
];

export interface SkillClassification {
  category: SkillCategory;
  /** 'high' is a named match; 'medium' is the shape of the name. */
  confidence: 'high' | 'medium';
  source: 'dictionary' | 'pattern';
}

/**
 * The kind of thing this skill is, or null when nothing here is sure enough to say.
 *
 * Null is the common, safe answer: nothing downstream proposes a change for a skill this
 * cannot place, so a guess is never shown to anyone.
 */
export function classifySkill(name: string): SkillClassification | null {
  const raw = (name ?? '').trim();
  if (!raw || raw.length > 80) return null;

  for (const variant of nameVariants(raw)) {
    const hit = dictionaryCategory(variant);
    if (hit) return { category: hit, confidence: 'high', source: 'dictionary' };
  }
  for (const [pattern, category] of PATTERNS) {
    if (pattern.test(raw)) return { category, confidence: 'medium', source: 'pattern' };
  }
  return null;
}

/** The category alone, for callers that only need the answer. */
export function suggestedSkillCategory(name: string): SkillCategory | null {
  return classifySkill(name)?.category ?? null;
}

/** The lookup key a cached classification is stored under — see lib/skills/cache.ts. */
export function skillCategoryKey(name: string): string {
  return skillIdentity((name ?? '').trim()).slice(0, 80);
}
