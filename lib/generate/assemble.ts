/**
 * Resume assembly — REQ-4.1, REQ-4.4, REQ-6.5.
 *
 * Turns ranked profile records into a ResumeDocument: section order from the role
 * category, bullets rewritten to mirror the job's language (grounded, verified), and
 * length capped by seniority.
 */

import { z } from 'zod';
import { nanoid } from 'nanoid';
import type {
  ContactInfo,
  ExperienceBulletRecord,
  JobRequirement,
  ProfileRecord,
  ProjectRecord,
  ResumeDocument,
  ResumeSection,
  RoleRecord,
  SectionKey,
  SkillRecord,
} from '../types';
import { profileFor } from '../retrieval/categories';
import { generateStructured } from '../ai/chain';
import type { DraftBudget } from '../ai/budget';
import { acceptRewriteOrFallback } from './grounding';
import { coerceHeading } from '../render/headings';
import { formatDateRange } from '../render/dates';

/** REQ-6.5 — page budget by seniority, expressed as a bullet allowance. */
export function bulletAllowance(job: JobRequirement | null, totalYears: number): number {
  const seniority = job?.seniority ?? 'unknown';
  const twoPagesJustified =
    totalYears >= 8 || seniority === 'senior' || seniority === 'lead';
  return twoPagesJustified ? 20 : 11;
}

const RewriteSchema = z.object({
  bullets: z.array(
    z.object({
      id: z.string(),
      rewritten: z.string(),
    }),
  ),
});

const REWRITE_SYSTEM = `You rephrase existing resume bullets so they echo a job posting's terminology. You are not a writer; you are a translator between two vocabularies for the same facts.

Hard rules:
- Never introduce a tool, technology, company, metric, number, or claim that is not already in the source bullet. If the source says "Postgres" and the posting says "relational databases", bridging that wording is fine. Adding "Kubernetes" because the posting wants it is not.
- Never inflate scope. "Helped build" does not become "led".
- Keep each bullet to one sentence, ideally under 30 words.
- Preserve every number exactly as written in the source. Do not round, scale, or add one.
- If a source bullet cannot be improved without inventing something, return it unchanged.

Shape to aim for where the source supports it: action + scale + outcome.`;

export interface AssembleInput {
  userId: string;
  contact: ContactInfo;
  job: JobRequirement | null;
  records: ProfileRecord[];
  roles: RoleRecord[];
  budget?: DraftBudget;
  /** Set false for the baseline resume (REQ-6.7) — no job to tailor toward. */
  rewrite?: boolean;
}

export interface AssembleResult {
  document: ResumeDocument;
  rewriteStats: { attempted: number; accepted: number; rejected: number };
}

export async function assembleResume(input: AssembleInput): Promise<AssembleResult> {
  const { userId, contact, job, records, roles, budget } = input;
  const shouldRewrite = (input.rewrite ?? true) && Boolean(job);

  const skills = records.filter((r): r is SkillRecord => r.type === 'skill');
  const bullets = records.filter(
    (r): r is ExperienceBulletRecord => r.type === 'experience-bullet',
  );
  const projects = records.filter((r): r is ProjectRecord => r.type === 'project');
  const education = records.filter((r) => r.type === 'education');
  const certifications = records.filter((r) => r.type === 'certification');
  const achievements = records.filter((r) => r.type === 'achievement');

  const totalYears = estimateYears(roles);
  const allowance = bulletAllowance(job, totalYears);
  const trimmedBullets = bullets.slice(0, allowance);

  // --- Grounded rewrite (REQ-4.4) --------------------------------------------
  const rewrites = new Map<string, string>();
  const stats = { attempted: 0, accepted: 0, rejected: 0 };

  if (shouldRewrite && trimmedBullets.length > 0 && job) {
    stats.attempted = trimmedBullets.length;
    try {
      const { data } = await generateStructured({
        schema: RewriteSchema,
        system: REWRITE_SYSTEM,
        prompt: buildRewritePrompt(trimmedBullets, job),
        options: { budget, temperature: 0.25 },
      });

      for (const b of data.bullets) {
        const source = trimmedBullets.find((t) => t.id === b.id);
        if (!source) continue;
        // Verify, don't trust (grounding.ts).
        const verdict = acceptRewriteOrFallback(b.rewritten, source.text);
        rewrites.set(source.id, verdict.text);
        if (verdict.accepted) stats.accepted += 1;
        else stats.rejected += 1;
      }
    } catch {
      // A failed rewrite is not a failed resume — fall back to the user's own words.
      stats.rejected = stats.attempted;
    }
  }

  const bulletText = (b: ExperienceBulletRecord) => rewrites.get(b.id) ?? b.text;

  // --- Sections ---------------------------------------------------------------
  const byKey: Partial<Record<SectionKey, ResumeSection>> = {};

  if (skills.length > 0) {
    // Ordered so job-required skills lead — the Skills section is weighted heavily
    // by parsers, so what sits at the front of it matters.
    const ordered = orderSkillsForJob(skills, job);
    byKey.skills = {
      key: 'skills',
      heading: coerceHeading('skills', undefined),
      items: [{ text: ordered.map((s) => s.name).join(', '), sourceRecordId: null }],
    };
  }

  if (trimmedBullets.length > 0) {
    const groups = roles
      .map((role) => {
        const items = trimmedBullets
          .filter((b) => b.roleId === role.id)
          .map((b) => ({ text: bulletText(b), sourceRecordId: b.id }));
        if (items.length === 0) return null;
        return {
          title: role.title,
          subtitle: role.company,
          dateRange: formatDateRange(role.startDate, role.endDate),
          items,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);

    const orphans = trimmedBullets
      .filter((b) => !roles.some((r) => r.id === b.roleId))
      .map((b) => ({ text: bulletText(b), sourceRecordId: b.id }));

    byKey.experience = {
      key: 'experience',
      heading: coerceHeading('experience', undefined),
      items: orphans,
      groups,
    };
  }

  if (projects.length > 0) {
    byKey.projects = {
      key: 'projects',
      heading: coerceHeading('projects', undefined),
      items: [],
      groups: projects.map((p) => ({
        title: p.name,
        subtitle: p.stack.slice(0, 6).join(', '),
        items: [
          { text: p.description, sourceRecordId: p.id },
          ...p.impactMetrics.map((m) => ({ text: m, sourceRecordId: p.id })),
        ],
      })),
    };
  }

  if (education.length > 0) {
    byKey.education = {
      key: 'education',
      heading: coerceHeading('education', undefined),
      items: education.map((e) => {
        const rec = e as Extract<ProfileRecord, { type: 'education' }>;
        return {
          text: [rec.credential, rec.field, rec.institution, formatDateRange(rec.startDate, rec.endDate)]
            .filter(Boolean)
            .join(' · '),
          sourceRecordId: rec.id,
        };
      }),
    };
  }

  if (certifications.length > 0) {
    byKey.certifications = {
      key: 'certifications',
      heading: coerceHeading('certifications', undefined),
      items: certifications.map((c) => {
        const rec = c as Extract<ProfileRecord, { type: 'certification' }>;
        return {
          text: [rec.name, rec.issuer].filter(Boolean).join(' · '),
          sourceRecordId: rec.id,
        };
      }),
    };
  }

  if (achievements.length > 0) {
    byKey.achievements = {
      key: 'achievements',
      heading: coerceHeading('achievements', undefined),
      items: achievements.map((a) => {
        const rec = a as Extract<ProfileRecord, { type: 'achievement' }>;
        return { text: `${rec.title}${rec.description ? ` — ${rec.description}` : ''}`, sourceRecordId: rec.id };
      }),
    };
  }

  // Section order comes from the role category (REQ-4.1).
  const order = profileFor(job?.category ?? 'general').sectionOrder;
  const sections = order
    .map((key) => byKey[key])
    .filter((s): s is ResumeSection => Boolean(s));

  const document: ResumeDocument = {
    id: nanoid(),
    userId,
    contact,
    sections,
    jobRequirement: job,
    renderMode: 'ats-strict',
    recordHashSnapshot: records.map((r) => r.contentHash),
    createdAt: new Date(),
  };

  return { document, rewriteStats: stats };
}

function buildRewritePrompt(
  bullets: ExperienceBulletRecord[],
  job: JobRequirement,
): string {
  const list = bullets.map((b) => `- id: ${b.id}\n  text: ${b.text}`).join('\n');
  return [
    `TARGET ROLE: ${job.roleTitle} (${job.seniority})`,
    `THE POSTING'S OWN TERMS: ${job.atsKeywords.slice(0, 25).join(', ')}`,
    `REQUIRED SKILLS: ${job.requiredSkills.slice(0, 20).join(', ')}`,
    '',
    'Rephrase each bullet below to echo the posting where the underlying fact already supports it. Return every id, even if unchanged.',
    '',
    list,
  ].join('\n');
}

function orderSkillsForJob(
  skills: SkillRecord[],
  job: JobRequirement | null,
): SkillRecord[] {
  if (!job) return skills;
  const wanted = new Set(
    [...job.requiredSkills, ...job.atsKeywords, ...job.preferredSkills].map((s) =>
      s.toLowerCase().trim(),
    ),
  );
  return [...skills].sort((a, b) => {
    const aw = wanted.has(a.name.toLowerCase().trim()) ? 0 : 1;
    const bw = wanted.has(b.name.toLowerCase().trim()) ? 0 : 1;
    return aw - bw;
  });
}

function estimateYears(roles: RoleRecord[]): number {
  if (roles.length === 0) return 0;
  const starts = roles
    .map((r) => Number(r.startDate.slice(0, 4)))
    .filter((n) => Number.isFinite(n) && n > 1950);
  if (starts.length === 0) return 0;
  return new Date().getFullYear() - Math.min(...starts);
}
