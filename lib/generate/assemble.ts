/**
 * Resume assembly — REQ-4.1, REQ-4.4, REQ-6.5.
 *
 * Turns ranked profile records into a ResumeDocument: section order from the role
 * category, bullets rewritten to mirror the job's language (grounded, verified), and
 * length capped by seniority.
 *
 * Every section a real resume needs is built here, not only the ones the generator
 * happened to start with — a resume that silently omits Publications or Education is not
 * a shorter resume, it is a wrong one. What the page budget varies is the tail: the three
 * lowest-value sections drop in a fixed order rather than the document spilling onto a
 * page nobody reads to the bottom of.
 */

import { z } from 'zod';
import { nanoid } from 'nanoid';
import type {
  AwardRecord,
  ContactInfo,
  ExperienceBulletRecord,
  InterestRecord,
  JobRequirement,
  LanguageRecord,
  ProfileRecord,
  ProjectRecord,
  PublicationRecord,
  ResumeDocument,
  ResumeItem,
  ResumeSection,
  RoleRecord,
  SectionKey,
  SkillRecord,
  SummaryRecord,
  VolunteeringRecord,
  WritingRecord,
} from '../types';
import { profileFor } from '../retrieval/categories';
import { generateStructured } from '../ai/chain';
import type { DraftBudget } from '../ai/budget';
import { acceptRewriteOrFallback } from './grounding';
import { coerceHeading } from '../render/headings';
import { formatDate, formatDateRange } from '../render/dates';

/** A second page is only worth opening if there is enough career to fill it. */
function twoPagesJustified(job: JobRequirement | null, totalYears: number): boolean {
  const seniority = job?.seniority ?? 'unknown';
  return totalYears >= 8 || seniority === 'senior' || seniority === 'lead';
}

/** REQ-6.5 — page budget by seniority, expressed as a bullet allowance. */
export function bulletAllowance(job: JobRequirement | null, totalYears: number): number {
  return twoPagesJustified(job, totalYears) ? 20 : 11;
}

/**
 * Content lines an A4 page holds — derived from the PDF stylesheet, not guessed. 842pt
 * of page less 80pt of vertical padding is 762pt; at 10.5pt on 1.4 leading that is ~51
 * lines, and the contact block plus the section headings a full resume prints (each
 * ~36pt once its margins and rule are counted) take back around 22 of them.
 *
 * This is the budget the tail sections are dropped against. Experience bullets are its
 * largest consumer but never its only one, which is why the bullet allowance on its own
 * cannot decide whether Interests fits.
 */
export const CONTENT_LINES_PER_PAGE = 29;

export function contentLineAllowance(
  job: JobRequirement | null,
  totalYears: number,
): number {
  return CONTENT_LINES_PER_PAGE * (twoPagesJustified(job, totalYears) ? 2 : 1);
}

/**
 * Sections eligible to be cut when the page is full. Nothing carrying evidence of what
 * someone can do is ever in here.
 */
export const DROPPABLE_SECTIONS: SectionKey[] = ['interests', 'languages', 'volunteering'];

/**
 * Drop order follows the category's own ranking, not a fixed list.
 *
 * A fixed order contradicted the category config: project-manager deliberately promotes
 * Volunteering above Projects, because for a PM it is the cheapest evidence of running
 * people — and then a global order cut it third anyway, so a full PM page lost precisely
 * the section that category had ranked highest. Whatever a category ranked lowest is what
 * it can most afford to lose, so the order is derived from the ranking itself.
 */
export function sectionDropOrder(order: SectionKey[]): SectionKey[] {
  return DROPPABLE_SECTIONS.slice().sort(
    (a, b) => indexOrLast(order, b) - indexOrLast(order, a),
  );
}

function indexOrLast(order: SectionKey[], key: SectionKey): number {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}

/**
 * Lines that must still be spare before Interests is printed at all. "It fits" is not
 * the bar: a resume one line short of full has better uses for that line, and Interests
 * earns its place only on a resume that is genuinely short.
 */
const INTERESTS_HEADROOM = 6;

/**
 * Cap on the joined-line sections. The budget accounting counts Languages and Interests
 * as one line each, which stays true only while the list is short enough to be one.
 */
const JOINED_LINE_MAX_ITEMS = 8;

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
  /** Sections that were built and then cut for space, in the order they were cut. */
  droppedForSpace: SectionKey[];
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
  const summaries = records.filter((r): r is SummaryRecord => r.type === 'summary');
  const papers = records.filter((r): r is PublicationRecord => r.type === 'publication');
  const articles = records.filter((r): r is WritingRecord => r.type === 'writing');
  const awards = records.filter((r): r is AwardRecord => r.type === 'award');
  const volunteering = records.filter(
    (r): r is VolunteeringRecord => r.type === 'volunteering',
  );
  const languages = records.filter((r): r is LanguageRecord => r.type === 'language');
  const interests = records.filter((r): r is InterestRecord => r.type === 'interest');

  const totalYears = estimateYears(roles);
  const allowance = bulletAllowance(job, totalYears);
  const lineBudget = contentLineAllowance(job, totalYears);
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

  // A summary is used, never composed: nothing here has licence to write a claim about
  // the user that no record supports (NFR-8). Only the newest one is printed — two
  // summaries is a contradiction, not a longer summary.
  const summary = newestFirst(summaries)[0];
  if (summary && summary.text.trim()) {
    byKey.summary = {
      key: 'summary',
      heading: coerceHeading('summary', undefined),
      items: [{ text: summary.text.trim(), sourceRecordId: summary.id }],
    };
  }

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

  // Papers and articles share this section because they share the one heading parsers
  // recognise (render/headings.ts). Papers lead: a reader scans a section top-down, and
  // a peer-reviewed paper is the stronger claim of the two.
  if (papers.length + articles.length > 0) {
    byKey.publications = {
      key: 'publications',
      heading: coerceHeading('publications', undefined),
      items: [
        ...papers.map((p) => ({ text: publicationLine(p), sourceRecordId: p.id })),
        ...articles.map((w) => ({ text: writingLine(w), sourceRecordId: w.id })),
      ],
    };
  }

  if (awards.length > 0) {
    byKey.awards = {
      key: 'awards',
      heading: coerceHeading('awards', undefined),
      items: awards.map((a) => ({
        text: joinParts([a.title, a.issuer, formatDate(a.date)], a.description),
        sourceRecordId: a.id,
      })),
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

  if (volunteering.length > 0) {
    byKey.volunteering = {
      key: 'volunteering',
      heading: coerceHeading('volunteering', undefined),
      items: volunteering.map((v) => ({
        text: joinParts([v.role, v.organization, formatDate(v.date)], v.description),
        sourceRecordId: v.id,
      })),
    };
  }

  // One comma-joined line, the way Skills is rendered. A bullet each turns four facts
  // worth half a line into four lines, and those lines come out of Experience.
  if (languages.length > 0) {
    byKey.languages = {
      key: 'languages',
      heading: coerceHeading('languages', undefined),
      items: [joinedLine(languages.slice(0, JOINED_LINE_MAX_ITEMS), languageLabel)],
    };
  }

  if (interests.length > 0) {
    byKey.interests = {
      key: 'interests',
      heading: coerceHeading('interests', undefined),
      items: [joinedLine(interests.slice(0, JOINED_LINE_MAX_ITEMS), (i) => i.name.trim())],
    };
  }

  // Section order comes from the role category (REQ-4.1), and the budget cuts against
  // that same ranking — whatever this category ranked lowest is what it can afford to
  // lose, so the two can never contradict each other.
  const order = profileFor(job?.category ?? 'general').sectionOrder;
  const droppedForSpace = fitToBudget(byKey, lineBudget, order);
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

  return { document, rewriteStats: stats, droppedForSpace };
}

/* -------------------------------------------------------------- page budget -- */

/** Lines a section costs once rendered: one per item, plus one per group title. */
export function sectionLines(section: ResumeSection): number {
  const groups = section.groups ?? [];
  return (
    section.items.length + groups.length + groups.reduce((n, g) => n + g.items.length, 0)
  );
}

function totalLines(byKey: Partial<Record<SectionKey, ResumeSection>>): number {
  return Object.values(byKey).reduce((n, s) => n + (s ? sectionLines(s) : 0), 0);
}

/**
 * Drops tail sections until the document fits, lowest value first. Mutates `byKey` and
 * returns what went, so the pipeline can say so rather than leaving the user to notice
 * that something they entered is missing.
 */
function fitToBudget(
  byKey: Partial<Record<SectionKey, ResumeSection>>,
  lineBudget: number,
  order: SectionKey[],
): SectionKey[] {
  const dropped: SectionKey[] = [];

  // Interests is held to a stricter test than "it fits": it prints only on a resume with
  // room to spare, never as the thing that fills the last line of the page.
  const interests = byKey.interests;
  if (interests) {
    const withoutInterests = totalLines(byKey) - sectionLines(interests);
    if (withoutInterests > lineBudget - INTERESTS_HEADROOM) {
      delete byKey.interests;
      dropped.push('interests');
    }
  }

  for (const key of sectionDropOrder(order)) {
    if (totalLines(byKey) <= lineBudget) break;
    if (!byKey[key]) continue;
    delete byKey[key];
    dropped.push(key);
  }

  return dropped;
}

/* ---------------------------------------------------------- item formatting -- */

function publicationLine(p: PublicationRecord): string {
  const parts = [p.title, p.venue, formatDate(p.date)];
  // A DOI is the one thing on a resume line that a reviewer can resolve to the actual
  // work. Status is load-bearing in the other direction: "under review" printed as
  // though published would be a claim the record does not support.
  if (p.doi) parts.push(`DOI ${p.doi}`);
  else if (p.isbn) parts.push(`ISBN ${p.isbn}`);
  if (p.status && p.status !== 'published') parts.push(statusLabel(p.status));
  return parts.filter(Boolean).join(' · ');
}

function writingLine(w: WritingRecord): string {
  return [w.title, w.venue, formatDate(w.date)].filter(Boolean).join(' · ');
}

function statusLabel(status: NonNullable<PublicationRecord['status']>): string {
  return status === 'under-review' ? 'Under review' : 'Preprint';
}

function languageLabel(l: LanguageRecord): string {
  return l.proficiency ? `${l.name} (${capitalize(l.proficiency)})` : l.name;
}

function joinParts(parts: Array<string | undefined>, trailing?: string): string {
  const head = parts.filter((p): p is string => Boolean(p && p.trim())).join(' · ');
  return trailing?.trim() ? `${head} — ${trailing.trim()}` : head;
}

/**
 * One line built from many records. `sourceRecordId` can only name one record, so it
 * names it when there is exactly one and is null otherwise — the same honest null the
 * Skills line carries, rather than a traceability link pointing at an arbitrary input.
 */
function joinedLine<T extends { id: string }>(
  records: T[],
  label: (r: T) => string,
): ResumeItem {
  return {
    text: records.map(label).filter(Boolean).join(', '),
    sourceRecordId: records.length === 1 ? records[0].id : null,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function newestFirst<T extends { updatedAt: Date }>(records: T[]): T[] {
  return [...records].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

/* ------------------------------------------------------------------ rewrite -- */

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
