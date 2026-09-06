/**
 * Job text -> structured JobRequirement (REQ-3.3) + sanity check (REQ-3.4).
 *
 * Downstream never learns whether the text came from a scrape, a paste, a LinkedIn
 * caption, or a two-word job title — everything normalizes here.
 */

import { z } from 'zod';
import type { JobRequirement, RoleCategory } from '../types';
import { generateStructured } from '../ai/chain';
import type { DraftBudget } from '../ai/budget';

const CATEGORIES: RoleCategory[] = [
  'seo',
  'full-stack',
  'ai-engineer',
  'project-manager',
  'data',
  'design',
  'general',
];

const JobSchema = z.object({
  roleTitle: z.string(),
  company: z.string().optional(),
  seniority: z.enum(['intern', 'entry', 'mid', 'senior', 'lead', 'unknown']),
  category: z.enum(['seo', 'full-stack', 'ai-engineer', 'project-manager', 'data', 'design', 'general']),
  requiredSkills: z.array(z.string()),
  preferredSkills: z.array(z.string()),
  responsibilities: z.array(z.string()),
  atsKeywords: z
    .array(z.string())
    .describe('Exact terms an ATS keyword filter would scan for. Prefer the posting\'s own wording.'),
  companyContext: z.string().optional(),
  tone: z.enum(['startup', 'corporate', 'agency', 'neutral']),
  yearsOfExperienceRequired: z.number().optional(),
  inputQuality: z
    .enum(['rich', 'thin', 'unusable'])
    .describe('rich = full posting; thin = a title or a couple of lines; unusable = not a job posting at all'),
  contradictions: z
    .array(z.string())
    .describe('Internal contradictions in the posting, e.g. "0-2 years experience" alongside "10 years of Kubernetes"'),
});

const SYSTEM = `You normalize job postings into structured data. Input may be a formal job description, a LinkedIn post, a recruiter's email, a scraped page, or just a job title — handle all of them.

Rules:
- Extract only what the text supports. Do not invent requirements that are not stated.
- atsKeywords should use the posting's own terminology, since that is what keyword filters match against.
- If the input is very thin (just a title), set inputQuality to "thin" and infer only widely-standard requirements for that role, keeping the keyword list short and generic rather than fabricating specifics.
- If the input is not a job posting at all, set inputQuality to "unusable".
- Report genuine internal contradictions; do not manufacture them.`;

/**
 * REQ-3.4 — deterministic consistency checks, run alongside the model's own
 * contradiction report. Catches the case where the model confidently returns a
 * coherent-looking object from garbage input.
 */
function sanityCheck(
  parsed: z.infer<typeof JobSchema>,
  rawText: string,
): { confidence: number; flags: string[] } {
  const flags: string[] = [];
  let confidence = 1;

  if (parsed.inputQuality === 'unusable') {
    flags.push("This doesn't look like a job posting. Check what you pasted.");
    confidence -= 0.6;
  } else if (parsed.inputQuality === 'thin') {
    flags.push(
      'Very little detail to work from — the resume will be tailored on standard expectations for this role rather than the specific posting.',
    );
    confidence -= 0.25;
  }

  for (const c of parsed.contradictions) {
    flags.push(`Contradiction in the posting: ${c}`);
    confidence -= 0.15;
  }

  // Seniority vs. stated years — a classic posting inconsistency.
  const years = parsed.yearsOfExperienceRequired;
  if (typeof years === 'number') {
    const expected: Record<string, [number, number]> = {
      intern: [0, 1],
      entry: [0, 2],
      mid: [2, 6],
      senior: [5, 12],
      lead: [7, 25],
      unknown: [0, 25],
    };
    const [lo, hi] = expected[parsed.seniority] ?? [0, 25];
    if (years < lo || years > hi) {
      flags.push(
        `The posting says ${parsed.seniority} level but asks for ${years} years of experience — those don't line up.`,
      );
      confidence -= 0.15;
    }
  }

  if (rawText.trim().length < 80) {
    flags.push('The input was very short.');
    confidence -= 0.15;
  }

  if (parsed.atsKeywords.length === 0) {
    flags.push('No usable keywords could be extracted, so keyword matching will be weak.');
    confidence -= 0.2;
  }

  return { confidence: Math.max(0, Math.min(1, confidence)), flags };
}

export async function extractJobRequirement(
  rawText: string,
  budget?: DraftBudget,
): Promise<JobRequirement> {
  const { data } = await generateStructured({
    schema: JobSchema,
    system: SYSTEM,
    prompt: `Normalize this job input:\n\n---\n${rawText.slice(0, 24_000)}\n---`,
    options: { budget, temperature: 0.1 },
  });

  const { confidence, flags } = sanityCheck(data, rawText);

  return {
    roleTitle: data.roleTitle,
    company: data.company,
    seniority: data.seniority,
    category: (CATEGORIES.includes(data.category as RoleCategory)
      ? data.category
      : 'general') as RoleCategory,
    requiredSkills: dedupe(data.requiredSkills),
    preferredSkills: dedupe(data.preferredSkills),
    responsibilities: data.responsibilities,
    atsKeywords: dedupe(data.atsKeywords),
    companyContext: data.companyContext,
    tone: data.tone,
    yearsOfExperienceRequired: data.yearsOfExperienceRequired,
    confidence,
    flags,
  };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const k = i.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(i.trim());
  }
  return out;
}
