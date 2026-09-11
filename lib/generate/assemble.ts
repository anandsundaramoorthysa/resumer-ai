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
import { draftCallOptions, type DraftBudget } from '../ai/budget';
import { acceptRewriteOrFallback } from './grounding';
import { draftSummary } from './summary';
import {
  educationLine,
  educationYears,
  formatSkillRow,
  groupSkills,
  relevanceScore,
  topByRelevance,
} from './resume-lines';
import { coerceHeading } from '../render/headings';
import { formatDate, formatDateRange } from '../render/dates';
import { canonicalSkillName, dedupeBySkillIdentity } from '../skills/identity';

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
 * The same page, counted in words instead of lines — AUDIT #7.
 *
 * The line budget above cannot see thinness: eleven bullets of four words each occupy
 * eleven lines and say nothing, which is how a 180-word document scored well enough to
 * ship. So the same page gets a second reading. The content column is A4 width less
 * 2×40pt of padding, and at 10.5pt that runs to roughly 95 characters — call it 15 words
 * — on a full line. Resume lines are not all full (a group title is three words, a date
 * range two), so ~12 words per content line is the honest average, and 29 × 12 ≈ 350.
 *
 * That the derivation lands on 350 matters: the research target for an entry-level
 * resume is 350–450 words for one page, and this number was reached from the stylesheet
 * without reference to it. Two independent routes to the same figure is the only reason
 * to trust either.
 */
export const CONTENT_WORDS_PER_PAGE = 350;

export function contentWordAllowance(
  job: JobRequirement | null,
  totalYears: number,
): number {
  return CONTENT_WORDS_PER_PAGE * (twoPagesJustified(job, totalYears) ? 2 : 1);
}

/* ------------------------------------------------------ bullets by recency -- */

/**
 * Per-role bullet counts — AUDIT #8.
 *
 * `bulletAllowance` caps the total and nothing spent it per role, so the order bullets
 * happened to arrive in decided everything: retrieval ranks by relevance to the posting,
 * and a 2019 internship whose stack matches the job takes four slots while the current
 * job takes one. A reader scans the top job first and finds it the thinnest thing on the
 * page.
 *
 * Research is consistent on the shape: 3–5 bullets on the most recent role, tapering to
 * 2–3 on older ones. `MAX` is the top of that band and `MIN` the bottom, and the taper is
 * one bullet per step down the list — a role at rank 3 or lower is old enough that the
 * distinction between it and rank 4 is not worth a line.
 */
const MIN_BULLETS_PER_ROLE = 2;
const MAX_BULLETS_PER_ROLE = 5;

function targetForRank(rank: number): number {
  return Math.max(MIN_BULLETS_PER_ROLE, MAX_BULLETS_PER_ROLE - rank);
}

/** A 'YYYY-MM' or 'YYYY' date as a sortable month number, or null when unusable. */
function monthIndex(date: string | undefined): number | null {
  const m = /^(\d{4})(?:-(\d{1,2}))?/.exec((date ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  if (!Number.isFinite(year) || year < 1950) return null;
  return year * 12 + (m[2] ? Number(m[2]) - 1 : 0);
}

/** Sorts above every real date: an ongoing job is more recent than any finished one. */
const ONGOING = Number.MAX_SAFE_INTEGER;

/** Sorts below every real date. See `rolesByRecency` for why undated roles land here. */
const UNDATED = -1;

function endIndex(role: RoleRecord): number {
  const end = (role.endDate ?? '').trim().toLowerCase();
  // A job you still hold is the most recent one you have, whatever its start date says.
  // Getting this wrong is the visible failure: a role that began in 2021 and has not
  // ended outranks one that ran through 2023, and sorting on start date alone reverses
  // exactly that pair.
  if (end === 'present' || end === 'current' || end === 'ongoing') return ONGOING;
  return monthIndex(role.endDate) ?? monthIndex(role.startDate) ?? UNDATED;
}

/**
 * Roles newest first.
 *
 * A role with no usable dates sorts last, and that is a deliberate choice rather than an
 * accident of the comparator. It cannot be placed anywhere else honestly — claiming it is
 * current would let an undated 2019 row outrank the job the person holds today. What it
 * is NOT allowed to do is disappear: the allocation below seats every role at
 * `MIN_BULLETS_PER_ROLE` before any role gets a second helping, so an undated role loses
 * only the taper, never its floor, and drops to zero solely when the total allowance is
 * too small to seat every role at all. The real fix is upstream — AUDIT #4 makes a
 * missing start date a write-time error — and this is what happens to the rows that
 * predate it.
 */
export function rolesByRecency(roles: RoleRecord[]): RoleRecord[] {
  return [...roles].sort((a, b) => {
    const diff = endIndex(b) - endIndex(a);
    if (diff !== 0) return diff;
    // Two jobs both marked present: the one started later is the current one.
    return (monthIndex(b.startDate) ?? UNDATED) - (monthIndex(a.startDate) ?? UNDATED);
  });
}

/**
 * Spends the bullet allowance across roles by recency instead of taking a flat top-N.
 *
 * Two passes, and the order matters. The floor pass seats every role first, so no job
 * vanishes from the resume because the one above it was interesting; only then does the
 * taper pass hand out the remainder, newest-first, up to each role's target. Within a
 * role the bullets keep the order retrieval gave them, so the taper picks the most
 * job-relevant ones — recency decides how many a role gets, relevance decides which.
 *
 * Bullets attached to no role are handled separately at the end. They cannot be given a
 * per-role target because they are not a role, and capping them would break the baseline
 * resume (REQ-6.7), which has no roles at all and would otherwise print two bullets.
 */
export function distributeBulletsByRecency(
  bullets: ExperienceBulletRecord[],
  roles: RoleRecord[],
  allowance: number,
): ExperienceBulletRecord[] {
  if (allowance <= 0) return [];

  const byRole = new Map<string, ExperienceBulletRecord[]>();
  for (const b of bullets) {
    if (!b.roleId || !roles.some((r) => r.id === b.roleId)) continue;
    const list = byRole.get(b.roleId) ?? [];
    list.push(b);
    byRole.set(b.roleId, list);
  }

  const ordered = rolesByRecency(roles).filter((r) => (byRole.get(r.id)?.length ?? 0) > 0);
  const taken = new Map<string, number>(ordered.map((r) => [r.id, 0]));
  let left = allowance;

  const give = (roleId: string, upTo: number): void => {
    const have = taken.get(roleId) ?? 0;
    const available = (byRole.get(roleId)?.length ?? 0) - have;
    const n = Math.min(upTo, available, left);
    if (n <= 0) return;
    taken.set(roleId, have + n);
    left -= n;
  };

  for (const role of ordered) give(role.id, MIN_BULLETS_PER_ROLE);

  // One at a time rather than target-at-once, so the newest role reaches five only after
  // every role has three — a taper, not a winner-takes-all.
  for (let round = MIN_BULLETS_PER_ROLE; round < MAX_BULLETS_PER_ROLE && left > 0; round++) {
    for (const [rank, role] of ordered.entries()) {
      if (left <= 0) break;
      if ((taken.get(role.id) ?? 0) < Math.min(targetForRank(rank), round + 1)) {
        give(role.id, 1);
      }
    }
  }

  const kept = new Set<string>();
  for (const [roleId, n] of taken) {
    for (const b of (byRole.get(roleId) ?? []).slice(0, n)) kept.add(b.id);
  }

  for (const b of bullets) {
    if (left <= 0) break;
    if (kept.has(b.id) || byRole.has(b.roleId ?? '')) continue;
    kept.add(b.id);
    left -= 1;
  }

  return bullets.filter((b) => kept.has(b.id));
}

/**
 * Sections eligible to be cut when the page is full. Nothing carrying evidence of what
 * someone can do is ever in here.
 */
// Volunteering prints in every resume, and Languages is now a row of Skills.
export const DROPPABLE_SECTIONS: SectionKey[] = ['interests'];

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
  /**
   * The whole profile, not just what retrieval selected. Education, activities,
   * volunteering, certifications and writing are chosen from here, because they print in
   * every resume whether or not retrieval thought they matched this job.
   */
  allRecords?: ProfileRecord[];
  roles: RoleRecord[];
  budget?: DraftBudget;
  /** Set false for the baseline resume (REQ-6.7) — no job to tailor toward. */
  rewrite?: boolean;
}

export interface AssembleResult {
  document: ResumeDocument;
  rewriteStats: { attempted: number; accepted: number; rejected: number };
  /**
   * WHICH bullets the grounding check refused a rewrite for, not just how many.
   *
   * The count alone was already reported to the user ("kept your original wording on 3
   * bullet(s)"), and it is the least useful half of what happened here. A refusal names
   * a specific record where the model, reading the posting, believed it could say
   * something stronger and was stopped because the profile does not state it — which is
   * as close as this system gets to knowing which single fact would most improve the
   * resume. lib/profile/enrichment.ts turns each one into a question; before that, the
   * identity was computed inside the loop below and dropped on the floor.
   */
  rejectedRewrites: Array<{ recordId: string; text: string }>;
  /**
   * Whether the grounded rewrite actually ran, and if not, why not.
   *
   * `rewriteStats.rejected` cannot answer that, and it has been silently conflating two
   * opposite findings. When the rewrite call throws, the catch below sets
   * `rejected = attempted` — so a run where the provider never answered is, in every
   * artefact this system keeps, indistinguishable from a run where the model tried
   * twelve bullets and the grounding check refused all twelve. The first is an outage,
   * the second is a thin profile, and until now the only place either was reported was a
   * progress line reading "kept your original wording on 12 bullet(s) where a rewrite
   * would have added something not in your profile" — which is a false statement about
   * the user's profile whenever the truth was that a provider timed out.
   *
   * A failed rewrite is still not a failed resume; the fallback stays exactly as it was.
   * This only names what happened, so lib/db/schema.ts's `draft_run` can store it and a
   * draft that used the model can be told apart from one that quietly did not.
   */
  rewriteFallback: {
    /** Bullets printed in the user's own words instead of a rewrite. */
    count: number;
    /** Of how many were sent. Zero when no rewrite was attempted at all. */
    attempted: number;
    /**
     *   none         nothing fell back, or nothing was attempted
     *   grounding    the model answered and the grounding check refused some of it
     *   call-failed  the request itself threw; no bullet was ever judged
     */
    reason: 'none' | 'grounding' | 'call-failed';
  };
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
  const all = input.allRecords ?? records;
  // Every qualification, newest first.
  const education = all
    .filter((r): r is Extract<ProfileRecord, { type: 'education' }> => r.type === 'education')
    .sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''));
  // Only the three most relevant — a list of 27 certificates is noise, three good ones
  // are evidence.
  const certifications = topByRelevance(all.filter((r) => r.type === 'certification'), job, 3);
  // Printed in every resume under "Campus and Community Activities".
  const achievements = all.filter((r) => r.type === 'achievement');
  const summaries = records.filter((r): r is SummaryRecord => r.type === 'summary');
  // Papers only when they bear on this job; blog posts, the three most relevant.
  const papers = all.filter(
    (r): r is PublicationRecord => r.type === 'publication' && relevanceScore(r, job) > 0,
  );
  const articles = topByRelevance(
    all.filter((r): r is WritingRecord => r.type === 'writing'),
    job,
    3,
  );
  const awards = records.filter((r): r is AwardRecord => r.type === 'award');
  const volunteering = all.filter((r): r is VolunteeringRecord => r.type === 'volunteering');
  const languages = all.filter((r): r is LanguageRecord => r.type === 'language');
  const interests = records.filter((r): r is InterestRecord => r.type === 'interest');

  const totalYears = estimateYears(roles);
  const allowance = bulletAllowance(job, totalYears);
  const lineBudget = contentLineAllowance(job, totalYears);
  const trimmedBullets = distributeBulletsByRecency(bullets, roles, allowance);

  // --- Summary, drafted in parallel with the rewrite below ---------------------
  // Started now so it costs no extra wall-clock time. The facts are both the prompt and
  // what the draft is grounded against — see ./summary.ts.
  const summaryFacts = [
    ...rolesByRecency(roles).map(
      (r) => `${r.title} at ${r.company} (${formatDateRange(r.startDate, r.endDate)})`,
    ),
    ...education.map((e) => `${e.credential}${e.field ? `, ${e.field}` : ''} — ${e.institution}`),
    `Skills: ${skills.map((s) => s.name).join(', ')}`,
    ...trimmedBullets.map((b) => b.text),
    ...projects.map((p) => `${p.name}: ${p.description ?? ''}`),
    ...achievements.map((a) => (a as Extract<ProfileRecord, { type: 'achievement' }>).title),
    ...newestFirst(summaries).slice(0, 1).map((s) => s.text),
  ].join('\n');
  const summaryPromise =
    shouldRewrite && job ? draftSummary({ job, facts: summaryFacts, budget }) : Promise.resolve(null);

  // --- Grounded rewrite (REQ-4.4) --------------------------------------------
  const rewrites = new Map<string, string>();
  const stats = { attempted: 0, accepted: 0, rejected: 0 };
  const rejectedRewrites: AssembleResult['rejectedRewrites'] = [];
  const rewriteFallback: AssembleResult['rewriteFallback'] = {
    count: 0,
    attempted: 0,
    reason: 'none',
  };

  if (shouldRewrite && trimmedBullets.length > 0 && job) {
    stats.attempted = trimmedBullets.length;
    rewriteFallback.attempted = trimmedBullets.length;
    try {
      const { data } = await generateStructured({
        schema: RewriteSchema,
        system: REWRITE_SYSTEM,
        prompt: buildRewritePrompt(trimmedBullets, job),
        options: draftCallOptions(budget, { temperature: 0.25 }),
      });

      for (const b of data.bullets) {
        const source = trimmedBullets.find((t) => t.id === b.id);
        if (!source) continue;
        // Verify, don't trust (grounding.ts).
        const verdict = acceptRewriteOrFallback(b.rewritten, source.text);
        rewrites.set(source.id, verdict.text);
        if (verdict.accepted) {
          stats.accepted += 1;
        } else {
          stats.rejected += 1;
          rejectedRewrites.push({ recordId: source.id, text: source.text });
        }
      }
      if (stats.rejected > 0) {
        rewriteFallback.count = stats.rejected;
        rewriteFallback.reason = 'grounding';
      }
    } catch {
      // A failed rewrite is not a failed resume — fall back to the user's own words.
      // Nothing is recorded as rejected here: a provider that timed out says nothing
      // about whether the bullet could have been strengthened, and asking the user to
      // supply a figure because a request failed would be asking for the wrong reason.
      stats.rejected = stats.attempted;
      // What `stats.rejected` alone could not say, and what it cost to be unable to say
      // it, is on `rewriteFallback` in AssembleResult above. The error itself is not
      // captured: it is a provider's own text, the caller does not fail because of it,
      // and the run either succeeds — in which case the reason slug is the whole finding
      // — or fails later for a cause that reaches the log on its own path.
      rewriteFallback.count = stats.attempted;
      rewriteFallback.reason = 'call-failed';
    }
  }

  const bulletText = (b: ExperienceBulletRecord) => rewrites.get(b.id) ?? b.text;

  // --- Sections ---------------------------------------------------------------
  const byKey: Partial<Record<SectionKey, ResumeSection>> = {};

  // A summary written for this job, grounded against the profile (./summary.ts). If the
  // draft fails its grounding check, the newest stored summary is used instead; if there
  // is none, the resume has no summary rather than an invented one.
  const drafted = await summaryPromise;
  const stored = newestFirst(summaries)[0];
  const summaryText = drafted ?? stored?.text.trim() ?? '';
  if (summaryText) {
    byKey.summary = {
      key: 'summary',
      heading: coerceHeading('summary', undefined),
      items: [{ text: summaryText, sourceRecordId: drafted ? null : stored!.id }],
    };
  }

  if (skills.length > 0 || languages.length > 0) {
    // Ordered so job-required skills lead — the Skills section is weighted heavily
    // by parsers, so what sits at the front of it matters.
    //
    // Deduplicated after ordering, not before (AUDIT #11): the ordering has already put
    // the job-relevant spelling first, so the survivor of "React"/"React.js" is the one
    // the posting asked for. Names print canonically — a Skills line reading
    // "React, ReactJS, react" costs three of the section's most valuable slots to say
    // one thing, and gives a parser three tokens where a recruiter sees carelessness.
    const ordered = dedupeBySkillIdentity(orderSkillsForJob(skills, job), (s) => s.name);
    // Labelled rows — "Databases: MongoDB, MySQL" — the layout the owner asked for.
    // Spoken languages are the last row rather than a section of their own.
    const categoryOf = new Map(ordered.map((s) => [canonicalSkillName(s.name), s.category]));
    const rows = groupSkills(
      ordered.map((s) => canonicalSkillName(s.name)),
      (n) => categoryOf.get(n),
    );
    if (languages.length > 0) rows.push({ label: 'Languages', names: languages.map(languageLabel) });
    byKey.skills = {
      key: 'skills',
      heading: coerceHeading('skills', undefined),
      items: rows.map((row) => ({ text: formatSkillRow(row), sourceRecordId: null })),
    };
  }

  if (roles.length > 0 || trimmedBullets.length > 0) {
    // EVERY role, newest first, with its dates exactly as stored — including roles with no
    // bullets. A role missing from the resume is a gap in the timeline a recruiter asks about.
    const groups = rolesByRecency(roles).map((role) => ({
      title: role.title,
      subtitle: role.company,
      dateRange: formatDateRange(role.startDate, role.endDate),
      items: trimmedBullets
        .filter((b) => b.roleId === role.id)
        .map((b) => ({ text: bulletText(b), sourceRecordId: b.id })),
    }));

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
        // A project with no description still belongs on the resume — its name and
        // stack are the point — but it must not contribute an item with no text.
        items: [
          ...(p.description?.trim()
            ? [{ text: p.description.trim(), sourceRecordId: p.id }]
            : []),
          ...p.impactMetrics
            .filter((m) => typeof m === 'string' && m.trim())
            .map((m) => ({ text: m.trim(), sourceRecordId: p.id })),
        ],
      })),
    };
  }

  if (education.length > 0) {
    // Institution and years on one line, the degree under it — no field printed twice.
    byKey.education = {
      key: 'education',
      heading: coerceHeading('education', undefined),
      items: [],
      groups: education.map((rec) => ({
        title: rec.institution,
        dateRange: educationYears(rec.startDate, rec.endDate),
        items: [{ text: educationLine(rec.credential, rec.field, rec.grade), sourceRecordId: rec.id }],
      })),
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
      heading: coerceHeading('achievements', 'Campus and Community Activities'),
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
    // Everything printed, including the always-included records retrieval did not select.
    recordHashSnapshot: [
      ...new Set(
        [...records, ...education, ...certifications, ...achievements, ...volunteering, ...papers, ...articles, ...languages].map(
          (r) => r.contentHash,
        ),
      ),
    ],
    createdAt: new Date(),
  };

  return { document, rewriteStats: stats, rejectedRewrites, rewriteFallback, droppedForSpace };
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
