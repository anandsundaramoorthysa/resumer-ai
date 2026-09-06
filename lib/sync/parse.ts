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
});

export type ExtractedProfile = z.infer<typeof ExtractionSchema>;

const SYSTEM = `You extract structured professional profile data from the source code and content files of a personal portfolio website.

Rules:
- Extract only what is actually written in the files. Never infer or embellish a project, a metric, or a job.
- Ignore UI copy, navigation labels, button text, and boilerplate — you want the person's real professional facts.
- For experience bullets, split "action", "scale" and "outcome" only when the text genuinely contains them. Leave scale/outcome empty rather than inventing them.
- Skills should be concrete technologies, tools, or named competencies — not adjectives.
- If a category has nothing in the source, return an empty array for it.`;

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
 * Extraction runs as several focused calls in parallel, each with a SMALL schema.
 *
 * The measurements that led here:
 *   one big call, one big schema      191s
 *   chunked corpus, same big schema   133s
 *   plus per-attempt timeouts         180s  (worse — see below)
 *
 * The schema was the bottleneck, not the corpus. A seven-branch nested schema fails on
 * most open-weight models, so every call walked the entire provider chain before
 * succeeding; adding timeouts just made each doomed walk cost a predictable maximum
 * instead of finishing sooner. Splitting into single-purpose schemas means each call
 * succeeds on the first provider, which is both far faster and far more reliable.
 */
const CHUNK_CHAR_BUDGET = 14_000;
const MAX_CHUNKS = 6;

const SkillsOnly = z.object({ skills: ExtractionSchema.shape.skills });
const ProjectsOnly = z.object({ projects: ExtractionSchema.shape.projects });
const ExperienceOnly = z.object({ experience: ExtractionSchema.shape.experience });
const CredentialsOnly = z.object({
  education: ExtractionSchema.shape.education,
  certifications: ExtractionSchema.shape.certifications,
  achievements: ExtractionSchema.shape.achievements,
});
const ContactOnly = z.object({ contact: ExtractionSchema.shape.contact });

export interface ExtractionPass {
  key: string;
  label: string;
  schema: z.ZodType<Partial<ExtractedProfile>>;
  ask: string;
}

/** One pass per category. Small schemas succeed on the first provider; the combined
 *  schema did not, which is what made the original single call take minutes. */
export const EXTRACTION_PASSES: ExtractionPass[] = [
  {
    key: 'skills',
    label: 'skills',
    schema: SkillsOnly as unknown as z.ZodType<Partial<ExtractedProfile>>,
    ask: 'every concrete technology, tool, language and named competency',
  },
  {
    key: 'experience',
    label: 'work experience',
    schema: ExperienceOnly as unknown as z.ZodType<Partial<ExtractedProfile>>,
    ask: 'every job or role, with its bullets split into action / scale / outcome',
  },
  {
    key: 'projects',
    label: 'projects',
    schema: ProjectsOnly as unknown as z.ZodType<Partial<ExtractedProfile>>,
    ask: 'every project, with its stack, links and any stated impact',
  },
  {
    key: 'credentials',
    label: 'education and certifications',
    schema: CredentialsOnly as unknown as z.ZodType<Partial<ExtractedProfile>>,
    ask: 'education, certifications and achievements',
  },
  {
    key: 'contact',
    label: 'contact details',
    schema: ContactOnly as unknown as z.ZodType<Partial<ExtractedProfile>>,
    ask: 'the contact details - name, email, phone, location and profile URLs',
  },
];

/** Runs a single extraction pass over the corpus. */
export async function runPass(
  pass: ExtractionPass,
  files: RepoFile[],
  budget?: DraftBudget,
): Promise<Partial<ExtractedProfile>> {
  const corpus = buildChunks(files, null).join('\n').slice(0, 45_000);
  if (!corpus.trim()) return {};

  const { data } = await generateStructured({
    schema: pass.schema,
    system: SYSTEM,
    prompt: `From this portfolio source, extract ${pass.ask}. Return nothing for anything not actually present.

${corpus}`,
    options: { budget, temperature: 0.1 },
  });
  return data;
}

/** Merges per-chunk results, de-duplicating by the same identity the sync uses. */
export function mergeExtractions(parts: ExtractedProfile[]): ExtractedProfile {
  const merged: ExtractedProfile = {
    contact: undefined,
    skills: [],
    projects: [],
    experience: [],
    education: [],
    certifications: [],
    achievements: [],
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
  }

  return merged;
}

/** Packs files into chunks, keeping whole files together where possible. */
function buildChunks(files: RepoFile[], liveSiteText: string | null): string[] {
  const chunks: string[] = [];
  let current = '';

  const push = () => {
    if (current.trim()) chunks.push(current);
    current = '';
  };

  for (const f of files) {
    if (chunks.length >= MAX_CHUNKS) break;
    const body = f.content.slice(0, CHUNK_CHAR_BUDGET);
    const piece = `--- FILE: ${f.path} ---\n${body}\n`;
    if (current.length + piece.length > CHUNK_CHAR_BUDGET) push();
    current += piece;
  }
  push();

  if (liveSiteText && chunks.length < MAX_CHUNKS) {
    chunks.push(
      `--- LIVE SITE TEXT (fallback) ---\n${liveSiteText.slice(0, CHUNK_CHAR_BUDGET)}\n`,
    );
  }

  return chunks.slice(0, MAX_CHUNKS);
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
