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

export async function parsePortfolio(
  files: RepoFile[],
  liveSiteText: string | null,
  budget?: DraftBudget,
): Promise<ParseResult> {
  const corpus = buildCorpus(files, liveSiteText);
  if (!corpus.trim()) {
    return { records: [], roles: [], contact: undefined, usedAi: false };
  }

  const { data } = await generateStructured({
    schema: ExtractionSchema,
    system: SYSTEM,
    prompt: `Extract the profile from these portfolio files.\n\n${corpus}`,
    options: { budget, temperature: 0.1 },
  });

  return toRecords(data);
}

function buildCorpus(files: RepoFile[], liveSiteText: string | null): string {
  const MAX_TOTAL = 60_000;
  let used = 0;
  const chunks: string[] = [];

  for (const f of files) {
    const body = f.content.slice(0, 8_000);
    const chunk = `--- FILE: ${f.path} ---\n${body}\n`;
    if (used + chunk.length > MAX_TOTAL) break;
    chunks.push(chunk);
    used += chunk.length;
  }

  if (liveSiteText && used < MAX_TOTAL) {
    chunks.push(
      `--- LIVE SITE TEXT (fallback) ---\n${liveSiteText.slice(0, MAX_TOTAL - used)}\n`,
    );
  }

  return chunks.join('\n');
}

function toRecords(data: ExtractedProfile): ParseResult {
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
