/**
 * Uploaded resume -> candidate profile records — tasks 2.2 / REQ-1.2.
 *
 * The record shapes, the merge, and the hashing are the ones the portfolio sync already
 * uses (lib/sync/parse.ts), so an imported fact and a synced fact are the same kind of
 * thing to everything downstream. Only three things differ here, and each for a reason:
 *
 *   - the prompt, because a resume is already a list of professional facts whereas a
 *     portfolio repo is mostly source code with facts buried in it;
 *   - `source: 'ai-import'` on everything produced (REQ-1.2);
 *   - nothing is written until the user confirms it (task 2.3), so this module stops at
 *     producing candidates.
 *
 * The extraction schema is restated rather than imported because lib/sync/parse.ts keeps
 * its own private; the shared contract is the exported `ExtractedProfile` type, which
 * this schema is checked against at compile time.
 */

import { findContactLinks, mergeContactLinks } from './contact-links';
import { z } from 'zod';
import { generateStructured } from '../ai/chain';
import type { DraftBudget } from '../ai/budget';
import type { ExtractedProfile } from '../sync/parse';
import { mergeExtractions, toRecords } from '../sync/parse';
import type { ParsedRecord } from '../sync/reconcile';
import { hashContent } from '../sync/reconcile';

const ResumeExtractionSchema = z.object({
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

  // An uploaded resume already has these sections written out, so extracting them is
  // strictly easier here than from portfolio source — and skipping them would silently
  // discard the parts of someone's existing resume they most want carried over.
  summary: z.string().optional(),
  publications: z.array(
    z.object({
      title: z.string(),
      venue: z.string(),
      date: z.string().optional(),
      doi: z.string().optional(),
      status: z.enum(['published', 'under-review', 'preprint']).optional(),
    }),
  ),
  writing: z.array(
    z.object({
      title: z.string(),
      venue: z.string(),
      date: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
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
  interests: z.array(z.string()),
});

/** Compile-time proof that this stays interchangeable with the sync extraction. */
type _SchemaMatchesSharedShape = z.infer<typeof ResumeExtractionSchema> extends
  ExtractedProfile
  ? true
  : never;
const _schemaCheck: _SchemaMatchesSharedShape = true;
void _schemaCheck;

const SYSTEM = `You extract structured professional facts from one excerpt of a person's existing resume.

Rules:
- Copy what the resume says. Never rewrite a metric, invent an outcome, or upgrade a job title.
- An excerpt is a fragment of a longer document. If it does not mention a category, return an empty array for that category — do not guess at what the rest of the resume might contain.
- Keep bullet text close to the original wording. Split "action", "scale" and "outcome" only where the sentence genuinely contains them; leave scale and outcome empty rather than inventing them.
- Skills are concrete technologies, tools, or named competencies — not adjectives like "motivated".
- If an experience entry's dates are not in this excerpt, use the empty string rather than a guess.`;

/**
 * One AI call per chunk, deliberately small.
 *
 * Same measurement that shaped the portfolio sync applies here: a 73k-char prompt took
 * 138s and failed, a 1.5k-char one took 6.2s. A chunk is sized for the second case, so
 * each call finishes well inside a single short request and the client can step through
 * them (the pattern in lib/sync/stepped.ts) instead of holding one long connection open.
 */
export async function extractFromChunk(
  chunk: string,
  budget?: DraftBudget,
): Promise<Partial<ExtractedProfile>> {
  if (!chunk.trim()) return {};

  const { data } = await generateStructured({
    schema: ResumeExtractionSchema as unknown as z.ZodType<Partial<ExtractedProfile>>,
    system: SYSTEM,
    prompt: `Resume excerpt:

${chunk}

Extract every professional fact this excerpt actually states. Return empty arrays for categories it does not mention.`,
    options: { budget, temperature: 0.1 },
  });

  /**
   * Contact links are read from the chunk's own text as well as from the model.
   *
   * A resume header renders its LinkedIn and GitHub links as icons, and a PDF extractor
   * turns those icons into the letters "in" or into nothing at all — leaving two bare
   * handles that the model quite reasonably declined to assign to either network. On a
   * real import that produced a profile with the website captured and both handles null,
   * so a generated resume carried no LinkedIn and no GitHub at all.
   *
   * `mergeContactLinks` only fills what the model left empty, so this can add a link but
   * never contradict one.
   */
  const links = findContactLinks(chunk);
  if (links.linkedinUrl || links.githubUrl || links.portfolioUrl) {
    return { ...data, contact: mergeContactLinks(data.contact, links) };
  }

  return data;
}

/* ----------------------------------------------------------- review model ---- */

/** One reviewable line in the confirm UI (task 2.3). */
export interface ImportCandidate {
  /** Stable for this import run; the review UI selects by it. */
  key: string;
  type: string;
  label: string;
  detail?: string;
  record: ParsedRecord;
}

export interface ImportRoleCandidate {
  key: string;
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  bullets: ImportCandidate[];
}

export interface ImportPreview {
  contact: ExtractedProfile['contact'];
  roles: ImportRoleCandidate[];
  records: ImportCandidate[];
  totalCount: number;
}

const TYPE_LABELS: Record<string, string> = {
  skill: 'Skill',
  'experience-bullet': 'Experience bullet',
  project: 'Project',
  education: 'Education',
  certification: 'Certification',
  achievement: 'Achievement',
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/**
 * Merges the per-chunk results and shapes them for review. Everything is re-stamped as
 * `ai-import` — `toRecords` marks its output as sync-sourced because that is its only
 * caller today, and provenance has to be truthful for REQ-1.2 to mean anything.
 */
export function buildPreview(partials: ExtractedProfile[]): ImportPreview {
  const merged = mergeExtractions(partials);
  const parsed = toRecords(merged);

  const bulletsByRole = new Map<string, ImportCandidate[]>();
  const records: ImportCandidate[] = [];

  for (const raw of parsed.records) {
    const record = { ...raw, source: 'ai-import' as const };
    const candidate: ImportCandidate = {
      key: `${record.type}:${record.contentHash}`,
      type: record.type,
      label: describe(record),
      detail: detailOf(record),
      record,
    };

    if (record.type === 'experience-bullet') {
      // `toRecords` parks the role's content hash in roleId; it becomes a real row id
      // only once the role is written (lib/import/commit.ts).
      const roleKey = String((record as unknown as { roleId: string }).roleId);
      const list = bulletsByRole.get(roleKey) ?? [];
      list.push(candidate);
      bulletsByRole.set(roleKey, list);
      continue;
    }
    records.push(candidate);
  }

  const roles: ImportRoleCandidate[] = parsed.roles.map((r) => ({
    key: r.contentHash,
    title: r.title,
    company: r.company,
    startDate: r.startDate,
    endDate: r.endDate,
    bullets: bulletsByRole.get(r.contentHash) ?? [],
  }));

  const totalCount =
    records.length + roles.reduce((n, r) => n + r.bullets.length, 0);

  return { contact: parsed.contact, roles, records, totalCount };
}

function describe(record: ParsedRecord): string {
  const r = record as unknown as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  switch (record.type) {
    case 'skill':
      return s('name');
    case 'experience-bullet':
      return s('text') || s('action');
    case 'project':
      return s('name');
    case 'education':
      return [s('credential'), s('field'), s('institution')].filter(Boolean).join(' · ');
    case 'certification':
      return [s('name'), s('issuer')].filter(Boolean).join(' · ');
    case 'achievement':
      return s('title');
    default:
      return record.type;
  }
}

function detailOf(record: ParsedRecord): string | undefined {
  const r = record as unknown as Record<string, unknown>;
  if (record.type === 'project') {
    const stack = Array.isArray(r.stack) ? (r.stack as string[]).join(', ') : '';
    return [typeof r.description === 'string' ? r.description : '', stack]
      .filter(Boolean)
      .join(' — ');
  }
  if (record.type === 'achievement') {
    return typeof r.description === 'string' ? r.description : undefined;
  }
  return undefined;
}

export { hashContent };
