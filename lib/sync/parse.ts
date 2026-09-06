/**
 * Portfolio content -> atomic profile records — REQ-2.3.
 *
 * Two paths, deliberately in this order:
 *   1. Structured data files (JSON/YAML frontmatter) parse deterministically — free,
 *      exact, no model involved.
 *   2. Whatever is left (content hardcoded inside components) goes through one AI
 *      extraction pass.
 *
 * Only the second path costs anything, so a well-structured portfolio syncs for free.
 */

import { z } from 'zod';
import type { ParsedRecord } from './reconcile';
import { hashContent } from './reconcile';
import { generateStructured } from '../ai/chain';
import type { DraftBudget } from '../ai/budget';
import type { RepoFile } from './github';

const ExtractionSchema = z.object({
  contact: z
    .object({
      fullName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      location: z.string().optional(),
      portfolioUrl: z.string().optional(),
      githubUrl: z.string().optional(),
      linkedinUrl: z.string().optional(),
    })
    .optional(),
  skills: z.array(
    z.object({
      name: z.string(),
      category: z.enum(['language', 'framework', 'tool', 'platform', 'soft-skill']),
    }),
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      stack: z.array(z.string()),
      links: z.array(z.string()),
      impactMetrics: z.array(z.string()),
    }),
  ),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      startDate: z.string().describe("'YYYY-MM' or 'YYYY'"),
      endDate: z.string().describe("'YYYY-MM', 'YYYY', or 'present'"),
      bullets: z.array(
        z.object({
          text: z.string(),
          action: z.string(),
          scale: z.string().optional(),
          outcome: z.string().optional(),
        }),
      ),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      credential: z.string(),
      field: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
  ),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string() })),
  achievements: z.array(z.object({ title: z.string(), description: z.string() })),

  /** A written professional summary, if the source states one. Never composed here. */
  summary: z.string().optional(),

  publications: z.array(
    z.object({
      title: z.string(),
      venue: z.string().describe('Conference, journal or publisher'),
      date: z.string().optional(),
      doi: z.string().optional(),
      status: z.enum(['published', 'under-review', 'preprint']).optional(),
    }),
  ),

  /** Articles and blog posts — evidence of communication, not of research. */
  writing: z.array(
    z.object({
      title: z.string(),
      venue: z.string().describe('Where it was published, e.g. Medium'),
      date: z.string().optional(),
      url: z.string().optional(),
    }),
  ),

  /** Competitive wins and formal recognition, kept apart from softer achievements. */
  awards: z.array(
    z.object({
      title: z.string(),
      issuer: z.string().optional(),
      date: z.string().optional(),
    }),
  ),

  languages: z.array(
    z.object({
      name: z.string(),
      proficiency: z
        .enum(['native', 'fluent', 'professional', 'conversational', 'basic'])
        .optional(),
    }),
  ),

  volunteering: z.array(
    z.object({
      role: z.string(),
      organization: z.string(),
      date: z.string().optional(),
      description: z.string().optional(),
    }),
  ),

  interests: z.array(z.string()).describe('Hobbies and personal interests'),
});

export type ExtractedProfile = z.infer<typeof ExtractionSchema>;

const SYSTEM = `You extract structured professional profile data from the source code and content files of a personal portfolio website.

Rules:
- Extract only what is actually written in the files. Never infer or embellish a project, a metric, or a job.
- Ignore UI copy, navigation labels, button text, and boilerplate — you want the person's real professional facts.
- For experience bullets, split "action", "scale" and "outcome" only when the text genuinely contains them. Leave scale/outcome empty rather than inventing them.
- Skills should be concrete technologies, tools, or named competencies — not adjectives.
- If a category has nothing in the source, return an empty array for it.

Category boundaries that are easy to get wrong:
- A language certificate ("Certification in Hindi Proficiency") is a LANGUAGE, not education. Education means academic degrees and diplomas only.
- A conference or journal paper is a publication. A blog post or article is writing. Do not merge them.
- A competition win or formal honour is an award. An achievement is a broader accomplishment that is not a prize.
- "Currently seeking a role", availability notes and career goals are not achievements. Skip them.
- Record every degree the source mentions, including earlier ones stated only in passing (a "previousDegree" field, or a sentence naming a bachelor's before a master's).
- Take the summary verbatim from the source if one exists. Never write one yourself.`;

export interface ParseResult {
  records: ParsedRecord[];
  roles: Array<{
    title: string;
    company: string;
    startDate: string;
    endDate: string;
    contentHash: string;
    bullets: ParsedRecord[];
  }>;
  contact: ExtractedProfile['contact'];
  usedAi: boolean;
}

/**
 * One unit of extraction work: a whole small file, or one slice of a large one.
 *
 * `attempt` counts how many times this slice has already been tried. It exists so a
 * slice whose extraction ran out of time can be re-queued and retried later in the
 * job, by which point the provider that stalled is on cooldown and a healthy one
 * answers instead.
 */
export interface WorkSlice {
  path: string;
  content: string;
  part?: number;
  parts?: number;
  attempt?: number;
}

/**
 * Chars per extraction call.
 *
 * Measured against the real repository, one pass:
 *   whole corpus  73k chars   138s, then failed on a provider quota
 *   one slice      6.0k chars   4.0-7.2s — too close to the step budget, slices dropped
 *   one slice      3.5k chars   1.1-5.8s — fits with room for a fallback provider
 *
 * Input size is what decides this, so the corpus is cut into pieces rather than
 * truncated at a file boundary: the portfolio's largest file is 17.7k chars, and
 * truncating it to fit would have silently dropped two thirds of the projects.
 */
const MAX_SLICE_CHARS = Number(process.env.SYNC_SLICE_CHARS ?? 3_500);

/**
 * Cuts the fetched corpus into extraction-sized units, splitting on line boundaries so
 * a record is never severed mid-line. Each unit is one step of the stepped sync.
 */
export function planSlices(files: RepoFile[]): WorkSlice[] {
  const slices: WorkSlice[] = [];

  for (const file of files) {
    const content = file.content;
    if (!content.trim()) continue;

    if (content.length <= MAX_SLICE_CHARS) {
      slices.push({ path: file.path, content });
      continue;
    }

    const chunks: string[] = [];
    let current = '';
    for (const line of content.split('\n')) {
      // A single monstrous line still has to go somewhere: give it its own chunk
      // rather than growing one past the budget.
      if (current && current.length + line.length + 1 > MAX_SLICE_CHARS) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n${line}` : line;
    }
    if (current.trim()) chunks.push(current);

    chunks.forEach((chunk, i) =>
      slices.push({
        path: file.path,
        content: chunk,
        part: i + 1,
        parts: chunks.length,
      }),
    );
  }

  return slices;
}

/**
 * Halves a slice that could not be extracted in the time available.
 *
 * A retry that re-sends the same content is only worth anything if the provider was
 * the problem. When the content is the problem — a dense slice that takes longer to
 * read and produces more JSON than the window allows — the useful retry is a smaller
 * one. Returns the slice unchanged when it is already too small to be worth halving.
 */
export function splitSlice(slice: WorkSlice): WorkSlice[] {
  const lines = slice.content.split('\n');
  if (slice.content.length < 800 || lines.length < 2) return [slice];

  const half = Math.ceil(lines.length / 2);
  return [lines.slice(0, half).join('\n'), lines.slice(half).join('\n')]
    .filter((content) => content.trim())
    .map((content) => ({ ...slice, content }));
}

/** Human-readable label for a slice — used in the sync's progress messages. */
export function sliceLabel(slice: WorkSlice): string {
  const name = slice.path.split('/').pop() ?? slice.path;
  return slice.parts && slice.parts > 1
    ? `${name} (${slice.part}/${slice.parts})`
    : name;
}

export interface ExtractOptions {
  budget?: DraftBudget;
  /** Wall clock the whole extraction may take, including provider fallback. */
  deadlineMs?: number;
  /** Wall clock any single provider attempt may take. */
  timeoutMs?: number;
  /** Which model tier to route to. See SYNC_TIER for why the sync picks what it does. */
  tier?: 'standard' | 'fast';
}

/**
 * One AI call per slice, bounded by the caller's deadline.
 *
 * `maxRetriesPerProvider: 0` is deliberate: the fallback chain already is the retry.
 * Retrying inside a provider doubles the worst case without adding a second opinion,
 * and the whole point of stepping the sync is that no single call may overrun.
 */
export async function extractFromSlice(
  slice: WorkSlice,
  options: ExtractOptions = {},
): Promise<Partial<ExtractedProfile>> {
  const body = slice.content.slice(0, MAX_SLICE_CHARS);
  if (!body.trim()) return {};

  const where =
    slice.parts && slice.parts > 1
      ? `${slice.path} (part ${slice.part} of ${slice.parts})`
      : slice.path;

  const { data } = await generateStructured({
    schema: ExtractionSchema as unknown as z.ZodType<Partial<ExtractedProfile>>,
    system: SYSTEM,
    prompt: `File: ${where}

Extract every professional fact this file actually contains. Return empty arrays for categories it does not mention.

${body}`,
    options: {
      budget: options.budget,
      tier: options.tier,
      temperature: 0.1,
      maxRetriesPerProvider: 0,
      timeoutMs: options.timeoutMs,
      deadlineMs: options.deadlineMs,
    },
  });
  return data;
}

/** Merges per-chunk results, de-duplicating by the same identity the sync uses. */
export function mergeExtractions(parts: Array<Partial<ExtractedProfile>>): ExtractedProfile {
  const merged: ExtractedProfile = {
    contact: undefined,
    summary: undefined,
    skills: [],
    projects: [],
    experience: [],
    education: [],
    certifications: [],
    achievements: [],
    publications: [],
    writing: [],
    awards: [],
    languages: [],
    volunteering: [],
    interests: [],
  };

  const seen = new Set<string>();
  const once = <T>(key: string, value: T, into: T[]) => {
    const k = key.toLowerCase().trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    into.push(value);
  };

  for (const p of parts) {
    if (!p) continue;
    // Contact details are filled in field by field: different chunks legitimately know
    // different pieces, and an early chunk shouldn't block a later, fuller one.
    if (p.contact) {
      merged.contact = { ...(p.contact ?? {}), ...(merged.contact ?? {}) };
      for (const [k, v] of Object.entries(p.contact)) {
        const key = k as keyof NonNullable<ExtractedProfile['contact']>;
        if (v && !merged.contact![key]) merged.contact![key] = v as string;
      }
    }
    for (const s of p.skills ?? []) once(`skill:${s.name}`, s, merged.skills);
    for (const pr of p.projects ?? []) once(`project:${pr.name}`, pr, merged.projects);
    for (const e of p.experience ?? [])
      once(`exp:${e.company}:${e.title}`, e, merged.experience);
    for (const ed of p.education ?? [])
      once(`edu:${ed.institution}:${ed.credential}`, ed, merged.education);
    for (const c of p.certifications ?? [])
      once(`cert:${c.name}`, c, merged.certifications);
    for (const a of p.achievements ?? []) once(`ach:${a.title}`, a, merged.achievements);
    for (const pb of p.publications ?? []) once(`pub:${pb.title}`, pb, merged.publications);
    for (const w of p.writing ?? []) once(`writ:${w.title}`, w, merged.writing);
    for (const aw of p.awards ?? []) once(`awd:${aw.title}`, aw, merged.awards);
    for (const l of p.languages ?? []) once(`lang:${l.name}`, l, merged.languages);
    for (const v of p.volunteering ?? [])
      once(`vol:${v.organization}:${v.role}`, v, merged.volunteering);
    for (const i of p.interests ?? []) once(`int:${i}`, i, merged.interests);

    // The fullest summary wins rather than the first seen: different files describe the
    // person at different lengths, and the longer one is invariably the written bio.
    if (p.summary && p.summary.length > (merged.summary?.length ?? 0)) {
      merged.summary = p.summary;
    }
  }

  return merged;
}

export function toRecords(data: ExtractedProfile): ParseResult {
  const records: ParsedRecord[] = [];

  for (const s of data.skills) {
    records.push({
      type: 'skill',
      name: s.name,
      category: s.category,
      tags: [s.name.toLowerCase(), s.category],
      contentHash: hashContent(['skill', s.name, s.category]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  for (const p of data.projects) {
    records.push({
      type: 'project',
      name: p.name,
      description: p.description,
      stack: p.stack,
      links: p.links,
      impactMetrics: p.impactMetrics,
      tags: [p.name.toLowerCase(), ...p.stack.map((s) => s.toLowerCase())],
      contentHash: hashContent(['project', p.name, p.description, p.stack.join(',')]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  const roles: ParseResult['roles'] = [];
  for (const e of data.experience) {
    const roleHash = hashContent(['role', e.company, e.title, e.startDate]);
    const bullets: ParsedRecord[] = e.bullets.map(
      (b) =>
        ({
          type: 'experience-bullet',
          roleId: roleHash, // resolved to a real role id when persisted
          text: b.text,
          action: b.action,
          scale: b.scale,
          outcome: b.outcome,
          tags: deriveTags(b.text),
          contentHash: hashContent(['bullet', e.company, b.text]),
          source: 'github-sync',
        }) as ParsedRecord,
    );
    roles.push({
      title: e.title,
      company: e.company,
      startDate: e.startDate,
      endDate: e.endDate || 'present',
      contentHash: roleHash,
      bullets,
    });
    records.push(...bullets);
  }

  for (const ed of data.education) {
    records.push({
      type: 'education',
      institution: ed.institution,
      credential: ed.credential,
      field: ed.field,
      startDate: ed.startDate,
      endDate: ed.endDate,
      tags: [ed.credential.toLowerCase(), ed.field?.toLowerCase() ?? ''].filter(Boolean),
      contentHash: hashContent(['education', ed.institution, ed.credential]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  for (const c of data.certifications) {
    records.push({
      type: 'certification',
      name: c.name,
      issuer: c.issuer,
      tags: [c.name.toLowerCase()],
      contentHash: hashContent(['cert', c.name, c.issuer]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  for (const a of data.achievements) {
    records.push({
      type: 'achievement',
      title: a.title,
      description: a.description,
      tags: deriveTags(`${a.title} ${a.description}`),
      contentHash: hashContent(['achievement', a.title]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  if (data.summary?.trim()) {
    records.push({
      type: 'summary',
      text: data.summary.trim(),
      tags: deriveTags(data.summary),
      contentHash: hashContent(['summary', data.summary]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  for (const p of data.publications ?? []) {
    records.push({
      type: 'publication',
      title: p.title,
      venue: p.venue,
      date: p.date,
      doi: p.doi,
      status: p.status,
      tags: deriveTags(`${p.title} ${p.venue}`),
      contentHash: hashContent(['publication', p.title]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  for (const w of data.writing ?? []) {
    records.push({
      type: 'writing',
      title: w.title,
      venue: w.venue,
      date: w.date,
      url: w.url,
      tags: deriveTags(w.title),
      contentHash: hashContent(['writing', w.title]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  for (const a of data.awards ?? []) {
    records.push({
      type: 'award',
      title: a.title,
      issuer: a.issuer,
      date: a.date,
      tags: deriveTags(`${a.title} ${a.issuer ?? ''}`),
      contentHash: hashContent(['award', a.title]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  for (const l of data.languages ?? []) {
    records.push({
      type: 'language',
      name: l.name,
      proficiency: l.proficiency,
      tags: [l.name.toLowerCase()],
      contentHash: hashContent(['language', l.name]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  for (const v of data.volunteering ?? []) {
    records.push({
      type: 'volunteering',
      role: v.role,
      organization: v.organization,
      date: v.date,
      description: v.description,
      tags: deriveTags(`${v.role} ${v.organization} ${v.description ?? ''}`),
      contentHash: hashContent(['volunteering', v.organization, v.role]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  for (const i of data.interests ?? []) {
    if (!i.trim()) continue;
    records.push({
      type: 'interest',
      name: i.trim(),
      tags: [i.toLowerCase().trim()],
      contentHash: hashContent(['interest', i]),
      source: 'github-sync',
    } as ParsedRecord);
  }

  return { records, roles, contact: data.contact, usedAi: true };
}

/** Cheap keyword tagging so retrieval has something to match on immediately. */
const TAG_VOCAB = [
  'react', 'next.js', 'typescript', 'javascript', 'node', 'python', 'sql', 'postgres',
  'mongodb', 'aws', 'docker', 'kubernetes', 'api', 'graphql', 'seo', 'analytics',
  'google analytics', 'wordpress', 'php', 'laravel', 'tailwind', 'figma', 'llm', 'rag',
  'machine learning', 'ai', 'agile', 'scrum', 'stakeholder', 'roadmap', 'leadership',
  'content', 'keyword', 'backlink', 'performance', 'testing', 'ci/cd', 'git',
];

function deriveTags(text: string): string[] {
  const lower = text.toLowerCase();
  return TAG_VOCAB.filter((t) => lower.includes(t));
}
