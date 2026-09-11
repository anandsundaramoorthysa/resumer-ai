/**
 * How individual resume lines are shaped — pure, so every rule here is tested without a
 * model or a database (tests/resume-lines.test.mts).
 */

import type { JobRequirement, ProfileRecord } from '../types';
import { recordText } from '../retrieval/rank';
import { keywordMatches, normalizeForMatch } from '../quality/keywords';

/* ------------------------------------------------------------------ skills -- */

/**
 * Skill rows, checked top to bottom — the first rule that matches wins.
 *
 * ponytail: a keyword table, so an unusual skill lands in "Other" rather than its best
 * row. Move to a model call if misfiled skills become common; the table covers every
 * skill in the owner's profile today.
 */
const SKILL_RULES: Array<[label: string, test: RegExp]> = [
  ['Programming Languages', /^(python|javascript|typescript|java|c|c\+\+|c#|go|golang|rust|dart|kotlin|swift|ruby|php|r|scala|bash|shell|matlab|emacs lisp)$/],
  ['Computer Science', /data structures|algorithms|object.oriented|\boop\b|operating systems|computer networks|system design/],
  ['Databases', /sql|mongo|postgres|firebase|firestore|redis|dynamo|sqlite|oracle|supabase|vector (db|database)|upstash|pinecone|elasticsearch|cassandra|\bdatabase/],
  ['AI and ML', /\bai\b|artificial intelligence|machine learning|deep learning|\bml\b|llm|large language|\brag\b|retrieval.augmented|nlp|natural language|prompt|agentic|\bmcp\b|model context|openai|gemini|groq|anthropic|hugging ?face|langchain|xgboost|lightgbm|scikit|sklearn|numpy|pandas|tf.idf|tensorflow|pytorch|keras|\bcnn\b|\bocr\b|optical character|random forest|gradient boost|pyspark|data science|exploratory|data preparation|vector search|computer vision|generative|chatbot|copilot|matplotlib|seaborn|data visuali[sz]ation|statistic|classification|clustering|segmentation|regression|time series|forecast|anomaly|hypothesis|a\/b test|experimentation/],
  ['Software and Tools', /\bgit\b|github|docker|kubernetes|ci\/?cd|jenkins|linux|\baws\b|azure|gcp|ec2|cloud|streamlit|vs ?code|emacs|org mode|jest|markdown|jira|figma|postman|vercel|netlify|flutter|version control/],
  ['Web', /react|next\.?js|node|express|html|css|tailwind|bootstrap|jquery|vue|angular|svelte|django|flask|fastapi|graphql|\bapi\b|web|front.?end|back.?end|full.?stack|\bcms\b|content management|payment/],
  ['Soft Skills', /communication|public speaking|presentation|time management|leadership|teamwork|problem.solving|adaptability|analytical|mindset|management|business development|technical writing/],
  ['Marketing and SEO', /\bseo\b|search engine|google analytics|search console|marketing|blogging|social media|copywriting/],
];

/** Rows print in this order, matching the layout the owner asked for. */
const ROW_ORDER = [
  'Programming Languages',
  'Computer Science',
  'Databases',
  'Web',
  'AI and ML',
  'Software and Tools',
  'Marketing and SEO',
  'Soft Skills',
  'Other',
  'Languages',
];

export interface SkillRow {
  label: string;
  names: string[];
}

/**
 * Sorts skill names into labelled rows. Order within a row is kept, so the caller's
 * job-relevance ordering still decides what leads.
 */
export function groupSkills(
  names: string[],
  categoryOf: (name: string) => string | undefined = () => undefined,
): SkillRow[] {
  const rows = new Map<string, string[]>();
  for (const name of names) {
    const n = name.toLowerCase().trim();
    if (!n) continue;
    let label = SKILL_RULES.find(([, test]) => test.test(n))?.[0];
    if (!label) {
      const category = categoryOf(name);
      label =
        category === 'soft-skill'
          ? 'Soft Skills'
          : category === 'language'
            ? 'Programming Languages'
            : 'Other';
    }
    rows.set(label, [...(rows.get(label) ?? []), name.trim()]);
  }
  return ROW_ORDER.filter((l) => rows.has(l)).map((label) => ({ label, names: rows.get(label)! }));
}

export function formatSkillRow(row: SkillRow): string {
  return `${row.label}: ${row.names.join(', ')}`;
}

/** The inverse of formatSkillRow, for code that edits a finished Skills section. */
export function parseSkillRow(text: string): SkillRow {
  const m = /^([^:]{1,40}):\s*(.*)$/.exec(text);
  const [label, list] = m ? [m[1].trim(), m[2]] : ['Other', text];
  return { label, names: list.split(',').map((s) => s.trim()).filter(Boolean) };
}

/* --------------------------------------------------------------- education -- */

const DEGREES: Array<[RegExp, string]> = [
  [/^m\.?\s?sc\.?/i, 'Master of Science'],
  [/^b\.?\s?sc\.?/i, 'Bachelor of Science'],
  [/^m\.?\s?tech\.?/i, 'Master of Technology'],
  [/^b\.?\s?tech\.?/i, 'Bachelor of Technology'],
  [/^m\.?\s?e\.?(?=\s)/i, 'Master of Engineering'],
  [/^b\.?\s?e\.?(?=\s)/i, 'Bachelor of Engineering'],
  [/^mba\b/i, 'Master of Business Administration'],
  [/^bba\b/i, 'Bachelor of Business Administration'],
  [/^mca\b/i, 'Master of Computer Applications'],
  [/^bca\b/i, 'Bachelor of Computer Applications'],
  [/^m\.?\s?com\.?/i, 'Master of Commerce'],
  [/^b\.?\s?com\.?/i, 'Bachelor of Commerce'],
  [/^m\.?\s?a\.?(?=\s)/i, 'Master of Arts'],
  [/^b\.?\s?a\.?(?=\s)/i, 'Bachelor of Arts'],
  [/^ph\.?\s?d\.?/i, 'Doctor of Philosophy'],
];

/**
 * "M.Sc. Data Science" + field "Data Science" + grade → "Master of Science, Data Science · 7.5 / 10".
 *
 * Stored credentials usually repeat the field ("B.Sc. Computer Science" / "Computer
 * Science"), and printing both put the subject on the line twice.
 */
export function educationLine(credential: string, field?: string, grade?: string): string {
  const cred = credential.trim();
  const degree = DEGREES.find(([re]) => re.test(cred));
  let name = cred;
  let subject = '';
  if (degree) {
    name = degree[1];
    subject = cred.replace(degree[0], '').replace(/^[\s,.\-–—in]*\b(in\s+)?/i, '').trim();
  }
  const f = (field ?? '').trim();
  const hay = `${name} ${subject}`.toLowerCase();
  if (f && !hay.includes(f.toLowerCase())) subject = subject ? `${subject}, ${f}` : f;

  const line = [name, subject].filter(Boolean).join(', ');
  return grade?.trim() ? `${line} · ${grade.trim()}` : line;
}

/** Years only — "2022 – 2025". Education is read by year, not month. */
export function educationYears(start?: string, end?: string): string {
  const year = (d?: string) => {
    if (!d) return '';
    if (/present|current|ongoing|pursuing/i.test(d)) return 'Present';
    return /\d{4}/.exec(d)?.[0] ?? '';
  };
  const s = year(start);
  const e = year(end);
  return s && e && s !== e ? `${s} – ${e}` : e || s;
}

/* --------------------------------------------------------------- relevance -- */

/** How many of the posting's terms a record mentions. */
export function relevanceScore(record: ProfileRecord, job: JobRequirement | null): number {
  if (!job) return 0;
  const text = normalizeForMatch(recordText(record));
  // Each term once: "SQL" is usually in both lists, and counting it twice let a SQL-only
  // record outrank one matching two different terms.
  const terms = [...new Set([...job.atsKeywords, ...job.requiredSkills, job.roleTitle].map((k) => k.toLowerCase()))];
  return terms.filter((k) => k && keywordMatches(text, k)).length;
}

function dateOf(r: ProfileRecord): string {
  const d = (r as { issuedDate?: string; date?: string }).issuedDate ?? (r as { date?: string }).date;
  return typeof d === 'string' ? d : '';
}

/** The `n` records most relevant to the job; newer first on a tie, then profile order. */
export function topByRelevance<T extends ProfileRecord>(
  records: T[],
  job: JobRequirement | null,
  n: number,
): T[] {
  return records
    .map((r, i) => ({ r, i, s: relevanceScore(r, job), d: dateOf(r) }))
    .sort((a, b) => b.s - a.s || b.d.localeCompare(a.d) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.r);
}
