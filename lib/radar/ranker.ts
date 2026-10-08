/**
 * Radar ranker — deterministic, no model call, no network. This module must never import lib/ai/*.
 * Postings are scored against the profile by a fixed skill lexicon and this file's own
 * whole-word matcher (`matchesSkill`).
 *
 * Why not the gate's keywordMatches / gatherFitFacts: the gate pluralises ("react" matches
 * "reacts"), drops multi-word terms that look like the job title ("machine learning" for an
 * ML posting), and over-matches aliases. The ranker owns a precompiled regex per lexicon term.
 *
 * Score (0-100), only when the profile holds at least one skill the posting names:
 *   coverage  = matched / (asked + 2)          smoothed: 1 of 1 is weaker evidence than 5 of 5
 *   score     = 80*coverage + seniority(<=10) + location(<=5) + title family(<=8), cap 100
 *   x0.8 when the description is under 120 chars and there are no highlights
 * Zero overlap => score 0 and reason NO_MATCH_REASON, so no-match sorts last and callers may drop it.
 * `coveragePct` stays the raw matched/asked ratio for display.
 */

import type { ContactInfo, JobRequirement, ProfileRecord, RoleRecord } from '../types';
import type { Posting, RankedPosting } from '../serp/types';
import { yearsOfWork } from '../fit/assess';
import { recordText } from '../retrieval/rank';

export const NO_MATCH_REASON = 'No skills in common with your profile';
export const MAX_POSTINGS = 50;

/** Explicit alias -> canonical lexicon term (also used for profile skill names). */
export const SKILL_ALIASES: Record<string, string> = {
  'restful api': 'rest api',
  'gen ai': 'generative ai',
  'next js': 'next.js',
  'ms excel': 'excel',
  golang: 'go',
  nodejs: 'node.js',
  'node js': 'node.js',
  reactjs: 'react',
  'react.js': 'react',
  'react js': 'react',
  'vue.js': 'vue',
  vuejs: 'vue',
  'express.js': 'express',
  expressjs: 'express',
  k8s: 'kubernetes',
  postgres: 'postgresql',
  'scikit learn': 'scikit-learn',
  sklearn: 'scikit-learn',
  'amazon web services': 'aws',
  js: 'javascript',
  ts: 'typescript',
};

const SEP = '[\\s-]+';
const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}])';
/** Case-insensitive spelling of a word inside a case-sensitive regex. */
const ci = (w: string) => w.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const WEB_FRAMEWORKS = 'react|vue|next|node|express|nuxt|angular|three|d3|backbone|ember';
const LANGS = ['python', 'java', 'rust', 'c\\+\\+', 'typescript', 'kotlin', 'ruby', 'scala', 'php'].map(ci).join('|');
const GO_CTX = ['back-?end', 'microservices', 'services?', 'language', 'developer', 'programming', 'engineer'].map(ci).join('|');

/** One form -> regex source. Spaces become separators; a '.' between letters is optional ('node.js' = 'nodejs'). */
function form(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') out += SEP;
    else if (c === '.' && /[a-z]/.test(s[i - 1] ?? '') && /[a-z]/.test(s[i + 1] ?? '')) out += '[.\\s-]?';
    else if (c === '/') out += '[/\\s-]?';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

interface Spec {
  term: string;
  res: RegExp[];
}
const spec = (term: string, source: string, flags = 'iu'): Spec => ({ term, res: [new RegExp(source, flags)] });
/** Plain term: its own name plus every alias that points at it, whole word, no plural. */
function plain(term: string, extra: string[] = [], plural = false): Spec {
  const forms = [term, ...extra, ...Object.entries(SKILL_ALIASES).filter(([, c]) => c === term).map(([a]) => a)];
  return spec(term, `${L}(?:${forms.map(form).join('|')})${plural ? 's?' : ''}${R}`);
}

/**
 * Ordered lexicon. Names where a trailing "s" is a different word (react, express, swift, rust,
 * spark, flask, go, ruby, redux, angular, next, vue, node) never pluralise: plural is opt-in.
 */
const SPECS: Spec[] = [
  plain('python'), plain('java'),
  // js alone is JavaScript, but not the "js" of vue.js / next js / react.js / node js.
  spec('javascript', `${L}javascript${R}|(?<![\\p{L}\\p{N}.])(?<!(?:${WEB_FRAMEWORKS})[.\\s-])js${R}`),
  plain('typescript'),
  // Go: golang, or capital-G "Go" beside a language/backend word or next to another language.
  spec(
    'go',
    `${ci('golang')}|` +
      `(?:${GO_CTX})\\W+(?:\\w+\\W+){0,3}(?<![\\p{L}\\p{N}.-])Go(?![\\p{L}.-]|\\s+to\\b)|` +
      `(?<![\\p{L}\\p{N}.-])Go(?![\\p{L}.-]|\\s+to\\b)\\W+(?:\\w+\\W+){0,3}(?:${GO_CTX})|` +
      `(?:${LANGS})\\s*[,/&]\\s*Go(?![\\p{L}.-])|(?<![\\p{L}\\p{N}.-])Go\\s*[,/&]\\s*(?:${LANGS})`,
    'u',
  ),
  plain('rust'), plain('c++'), plain('c#'), plain('php'), plain('ruby'), plain('kotlin'),
  // Swift only with Apple context.
  spec('swift', `${L}swiftui${R}|^(?=[\\s\\S]*\\b(?:ios|xcode|iphone)\\b)[\\s\\S]*?${L}swift${R}`),
  plain('scala'),
  spec('react', `${L}react(?:[.\\s-]?js)?(?![\\p{L}])(?![\\s-]*native)(?!\\s+(?:to|quickly|fast|appropriately|accordingly)\\b)`),
  plain('react native'),
  plain('next.js'), plain('node.js'), plain('angular', ['angularjs']), plain('vue', ['vue.js', 'vuejs']),
  // express only as Express.js: bare "express" is delivery / "express interest".
  spec('express', `${L}express(?:[.\\s-]?js)${R}`),
  plain('django'), plain('flask'), plain('fastapi'), plain('spring boot'),
  spec('spring', `${L}spring${SEP}(?:boot|mvc|framework|security|cloud|data)${R}|${L}spring\\.io${R}`),
  plain('hibernate'),
  plain('.net', ['asp.net', 'dotnet', '.net core']),
  plain('html'), plain('css'), plain('tailwind'), plain('redux'), plain('graphql'), plain('rest api', ['restful apis', 'rest apis'], false),
  plain('microservices', ['microservice']),
  plain('sql'), plain('postgresql'), plain('mysql'), plain('mongodb'), plain('redis'), plain('elasticsearch'),
  plain('kafka'), plain('rabbitmq'), plain('snowflake'), plain('bigquery'), plain('spark', ['apache spark']), plain('pyspark'), plain('hadoop'),
  plain('aws'), plain('azure'), plain('gcp'), plain('docker'), plain('kubernetes'), plain('terraform'),
  plain('ci/cd'), plain('github actions'), plain('jenkins'), plain('devops'),
  // git: the tool or its hosts, not "the git of it".
  spec('git', `${L}git(?:hub|lab)?${R}(?!\\s+of\\b)|${L}version${SEP}control${R}`),
  plain('linux'),
  plain('machine learning'), plain('deep learning'), plain('mlops'), plain('nlp'), plain('pytorch'), plain('tensorflow'),
  plain('pandas'), plain('numpy'), plain('scikit-learn'), plain('opencv'),
  plain('llm', [], true), plain('generative ai'), plain('langchain'), plain('prompt engineering'),
  spec('rag', `\\bRAG\\b|retrieval[\\s-]augmented`, 'u'),
  plain('power bi'), plain('tableau'), plain('looker'),
  // "excel" the verb: "excel in", "to excel".
  spec('excel', `${L}(?<!\\bto${SEP})excel${R}(?!\\s+(?:in|at|as|on|under)\\b)`),
  plain('data visualization', ['data visualisation', 'data viz']), plain('data analysis'),
  plain('etl'), plain('airflow'), plain('dbt'),
  plain('figma'), plain('ui/ux'), plain('photoshop'), plain('canva'),
  plain('agile'), plain('scrum'), plain('jira'),
  plain('seo'), spec('sem', `\\bSEM\\b`, 'u'), plain('google analytics'), plain('content marketing'), plain('social media'),
  plain('copywriting'), plain('email marketing'), plain('digital marketing'),
  plain('product management'),
  plain('selenium'), plain('playwright'), plain('cypress'), plain('postman'), plain('manual testing'),
  plain('android'), plain('ios'), plain('flutter'),
  spec('sap', `\\bSAP\\b`, 'u'), plain('tally'), plain('gst'), plain('accounting'), plain('salesforce'),
  plain('recruitment'), plain('payroll'),
];

export const SKILL_LEXICON: string[] = SPECS.map((s) => s.term);
const LEXICON_SET = new Set(SKILL_LEXICON);
const SPEC_BY_TERM = new Map(SPECS.map((s) => [s.term, s.res]));

/** Shared whole-word matcher: does `text` (raw) mention lexicon `term`? Unknown terms never match. */
export function matchesSkill(text: string, term: string): boolean {
  return SPEC_BY_TERM.get(term)?.some((re) => re.test(text)) ?? false;
}

/** Lexicon skills a text mentions, in lexicon order. */
export function mentionedSkills(text: string): string[] {
  return SPECS.filter((s) => s.res.some((re) => re.test(text))).map((s) => s.term);
}

/** Lexicon terms a skill *name* denotes: exact/alias first (a bare "Go" skill is Go), else mentions. */
export function canonicalSkills(name: string): string[] {
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const direct = SKILL_ALIASES[n] ?? n;
  return LEXICON_SET.has(direct) ? [direct] : mentionedSkills(name);
}

/** Skills a profile holds. Skill-record names and project stacks count directly; all text is scanned too. */
export function heldSkills(records: ProfileRecord[], roles: RoleRecord[]): Set<string> {
  const held = new Set<string>();
  const text: string[] = [];
  for (const r of records) {
    text.push(recordText(r));
    if (r.type === 'skill') canonicalSkills(r.name ?? '').forEach((s) => held.add(s));
    if (r.type === 'project') (r.stack ?? []).forEach((n) => canonicalSkills(n ?? '').forEach((s) => held.add(s)));
  }
  text.push(...roles.map((r) => r.title));
  mentionedSkills(text.join('\n')).forEach((s) => held.add(s));
  return held;
}

const SENIORITY_RANK = { intern: 0, entry: 1, mid: 2, senior: 3, lead: 4 } as const;

export function seniorityOf(title: string): JobRequirement['seniority'] {
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b|\btrainee\b/.test(t)) return 'intern';
  if (/\b(lead|principal|staff|head|manager|architect)\b/.test(t)) return 'lead';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|associate|graduate|entry)\b|\bfresher/.test(t)) return 'entry';
  return 'unknown';
}

export function profileSeniority(years: number): keyof typeof SENIORITY_RANK {
  return years < 0.5 ? 'intern' : years < 2 ? 'entry' : years < 5 ? 'mid' : 'senior';
}

function seniorityBonus(title: string, years: number): number {
  const s = seniorityOf(title);
  if (s === 'unknown') return 3;
  const diff = Math.abs(SENIORITY_RANK[s] - SENIORITY_RANK[profileSeniority(years)]);
  return diff === 0 ? 10 : diff === 1 ? 5 : 0;
}

const CITY_ALIASES: Record<string, string> = { bangalore: 'bengaluru', gurgaon: 'gurugram', bombay: 'mumbai', madras: 'chennai', calcutta: 'kolkata' };
const CITY_RE = new RegExp(`\\b(${Object.keys(CITY_ALIASES).join('|')})\\b`, 'g');

/** Lowercased city with old names mapped to current ones (Bangalore -> bengaluru). */
export function normalizeCity(s: string): string {
  return s.toLowerCase().replace(CITY_RE, (m) => CITY_ALIASES[m]).trim();
}

function locationBonus(posting: Posting, city: string | null): number {
  const loc = normalizeCity(posting.location);
  if (/remote|anywhere/.test(loc)) return 5;
  return city && loc.includes(city) ? 5 : 0;
}

const FAMILIES: Array<[string, RegExp]> = [
  ['ml', /\b(machine learning|ml|ai|data scien\w*|deep learning|nlp|mlops|computer vision)\b/],
  ['data', /\b(data|analyst|analytics|bi|business intelligence|reporting)\b/],
  ['web', /\b(web|frontend|front-end|backend|back-end|full[- ]?stack|software|developer|sde|programmer|engineer)\b/],
  ['devops', /\b(devops|sre|cloud|platform|infrastructure)\b/],
  ['qa', /\b(qa|quality|tester|testing|sdet)\b/],
  ['marketing', /\b(marketing|seo|content|copywriter|social media|brand|growth)\b/],
  ['design', /\b(designer|design|ux|ui|creative)\b/],
  ['hr', /\b(hr|recruiter|recruitment|talent|payroll|human resources)\b/],
  ['finance', /\b(accountant|accounting|finance|financial|audit|tax|gst)\b/],
  ['mobile', /\b(android|ios|mobile|flutter)\b/],
];

function familiesOf(title: string): Set<string> {
  const t = title.toLowerCase();
  return new Set(FAMILIES.filter(([, re]) => re.test(t)).map(([f]) => f));
}

function titleBonus(title: string, profileFamilies: Set<string>): number {
  for (const f of familiesOf(title)) if (profileFamilies.has(f)) return 8;
  return 0;
}

export function rankPostings(
  postings: Posting[],
  profile: { records: ProfileRecord[]; roles: RoleRecord[]; contact: ContactInfo },
  topK = 5,
): RankedPosting[] {
  const city = profile.contact.location ? normalizeCity(profile.contact.location.split(',')[0]) || null : null;
  const held = heldSkills(profile.records, profile.roles);
  const years = yearsOfWork(profile.roles, new Date());
  const profileFamilies = new Set(profile.roles.flatMap((r) => [...familiesOf(r.title)]));

  const ranked = postings.slice(0, MAX_POSTINGS).map((p): RankedPosting => {
    const skills = mentionedSkills(`${p.title}\n${p.highlights.join('\n')}\n${p.description}`);
    const matched = skills.filter((s) => held.has(s));
    const missing = skills.filter((s) => !held.has(s));
    const short = p.description.trim().length < 120 && p.highlights.length === 0;
    const coveragePct = skills.length === 0 ? 0 : Math.round((matched.length / skills.length) * 100);
    if (matched.length === 0) {
      const reason =
        skills.length === 0
          ? short
            ? 'Short description, so the fit is a rough guess.'
            : 'No recognisable skills in the posting to compare.'
          : NO_MATCH_REASON;
      return { key: p.key, score: 0, coveragePct, matched, missing, reason };
    }
    const smoothed = matched.length / (skills.length + 2);
    const raw = smoothed * 80 + seniorityBonus(p.title, years) + locationBonus(p, city) + titleBonus(p.title, profileFamilies);
    const score = Math.round(Math.min(100, short ? raw * 0.8 : raw));
    const reason = `You hold ${matched.length} of ${skills.length} skills it names${missing.length ? `; missing ${missing.slice(0, 3).join(', ')}` : ''}${short ? ' (short description, rough estimate)' : ''}.`;
    return { key: p.key, score, coveragePct, matched, missing, reason };
  });
  return ranked
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, topK);
}
