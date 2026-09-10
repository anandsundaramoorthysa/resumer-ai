/**
 * Targeted revision — REQ-5.4.
 *
 * Fixes only what the critique flagged, and leaves everything that already scored well
 * completely untouched. Two reasons that matters: each pass stays cheap, and the resume
 * stops drifting further from source truth with every iteration.
 *
 * Deterministic fixes are applied FIRST and without a model call — missing skills,
 * numeric dates, decorative bullets and icon glyphs are all mechanical. Only weak
 * evidence needs the model, because only that requires judgment.
 */

import { z } from 'zod';
import type {
  Critique,
  ProfileRecord,
  ProjectRecord,
  ResumeDocument,
  ResumeSection,
  SkillRecord,
} from '../types';
import { generateStructured } from '../ai/chain';
import { draftCallOptions, type DraftBudget } from '../ai/budget';
import { acceptRewriteOrFallback } from './grounding';
import { trimToPage } from './fit-page';
import { formatDate } from '../render/dates';
import { holdsKeyword } from '../quality/vocabulary';
import {
  keywordMatches,
  normalizeForMatch,
  scoreKeywordCoverage,
} from '../quality/keywords';
import type { ReviseOutcome } from '../quality/loop';

const ReviseSchema = z.object({
  revisions: z.array(
    z.object({
      original: z.string(),
      revised: z.string(),
    }),
  ),
});

/**
 * The instruction that has to come first is the one about doing nothing.
 *
 * This prompt used to open by defining a weak bullet as one that "shows no scale and no
 * outcome", and in the next sentence ask the model to make "its existing result" specific
 * — of a bullet that, by the definition just given, has no result to work with. The only
 * way to satisfy both readings is to supply the missing result, and the rule that says not
 * to was three lines further down, after the rewrite had already been framed as the job.
 * Leading with the licence to return a bullet untouched costs nothing when a bullet can be
 * improved and is the whole answer when it cannot.
 */
const REVISE_SYSTEM = `You strengthen weak resume bullets using ONLY the facts already present in each bullet.

Returning a bullet exactly as you received it is a correct answer, and often the right one. Many bullets carry no metric and no stated outcome; for those there is nothing to strengthen, and inventing one is the single worst thing you can do here.

Where a bullet does state an action, a scale or a result, make those specific and active — sharper verb, less hedging, the facts already there brought forward.

Absolute rules:
- Never add a number, percentage, tool, company, or claim that is not already in the original bullet. If there is no metric in the original, there is no metric in your revision — restructure for clarity instead, or return it unchanged.
- One sentence, under 30 words.`;

export async function reviseDocument(
  doc: ResumeDocument,
  critiques: Critique[],
  allRecords: ProfileRecord[],
  budget?: DraftBudget,
): Promise<ReviseOutcome> {
  let next: ResumeDocument = structuredClone(doc);
  const unimprovable: string[] = [];

  // ---- 1. Deterministic fixes, no model call --------------------------------
  next = applySkillsFix(next, critiques, allRecords);
  next = applyKeywordFix(next, critiques, allRecords);
  next = applyRecordSwapIn(next, critiques, allRecords);
  next = sanitizeText(next);
  next = applyLengthFix(next, critiques);

  // ---- 2. Evidence fixes, model-assisted, grounded ---------------------------
  // Only bullets still on the page. The length fix above may have just removed some, and
  // a rewrite of a line that is no longer there is a model call bought for nothing.
  const onPage = new Set(allItemTexts(next));
  const evidenceTargets = critiques
    .filter((c) => c.subScore === 'evidence')
    .map((c) => extractQuoted(c.message))
    .filter((t): t is string => Boolean(t) && onPage.has(t!.trim()));

  if (evidenceTargets.length > 0) {
    try {
      const { data } = await generateStructured({
        schema: ReviseSchema,
        system: REVISE_SYSTEM,
        prompt: `Strengthen these bullets. Return each original alongside its revision.\n\n${evidenceTargets
          .map((t, i) => `${i + 1}. ${t}`)
          .join('\n')}`,
        options: draftCallOptions(budget, { temperature: 0.25 }),
      });

      const map = new Map<string, string>();
      for (const r of data.revisions) {
        // Verified against the original, same as first-pass generation.
        const verdict = acceptRewriteOrFallback(r.revised, r.original);
        if (verdict.accepted && verdict.text.trim() !== r.original.trim()) {
          map.set(r.original.trim(), verdict.text);
        }
      }
      next = replaceBulletText(next, map);

      // A target the model returned unchanged, left out, or dressed up with a number it
      // invented is a bullet the source facts cannot support. Saying so is the point: the
      // scorer would otherwise raise it again next iteration, and the pass after that.
      for (const target of evidenceTargets) {
        if (!map.has(target.trim())) unimprovable.push(target.trim());
      }
    } catch {
      // Leave the bullets as they were — a failed revision must not corrupt the draft.
      // These targets are NOT recorded as unimprovable: a provider that timed out says
      // nothing about whether the bullet could have been strengthened.
    }
  }

  return { document: next, changed: differs(doc, next), unimprovable };
}

/**
 * Whether a pass actually altered the document.
 *
 * Compared by serialising the sections rather than by trusting each fix path to report
 * itself: three of them mutate in place through shared helpers, and a signal assembled
 * from four separate "I think I changed something" booleans is exactly the kind that
 * drifts out of agreement with the document the moment a fifth is added. The sections of
 * a resume are a few KB, and this runs at most four times per draft.
 */
function differs(before: ResumeDocument, after: ResumeDocument): boolean {
  return JSON.stringify(before.sections) !== JSON.stringify(after.sections);
}

/** Pull skills the user demonstrably has into the Skills section (REQ-5.2 fix path). */
function applySkillsFix(
  doc: ResumeDocument,
  critiques: Critique[],
  records: ProfileRecord[],
): ResumeDocument {
  const skillsCritique = critiques.find((c) => c.subScore === 'skills');
  if (!skillsCritique) return doc;

  const missing = parseListAfterColon(skillsCritique.message);
  if (missing.length === 0) return doc;

  const vocabulary = new Set<string>();
  for (const r of records) {
    for (const t of r.tags) vocabulary.add(t.toLowerCase());
    if (r.type === 'skill') vocabulary.add((r as SkillRecord).name.toLowerCase());
    if (r.type === 'project') for (const s of r.stack) vocabulary.add(s.toLowerCase());
  }

  // Only add what the profile actually supports — never invent a skill to score.
  // Uses the same one-directional, whole-phrase rule as the scorer, so the gate and the
  // fix can never disagree about what counts as held.
  const additions = missing.filter((m) => holdsKeyword(vocabulary, m));
  if (additions.length === 0) return doc;

  const section = doc.sections.find((s) => s.key === 'skills');
  if (!section) return doc;

  const current = section.items[0]?.text ?? '';
  const existing = new Set(
    current.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const merged = [
    ...additions.filter((a) => !existing.has(a.toLowerCase())),
    ...current.split(',').map((s) => s.trim()).filter(Boolean),
  ];

  section.items = [{ text: merged.join(', '), sourceRecordId: null }];
  return doc;
}

/** Same idea for the keyword gate: surface held-but-missing terms (REQ-5.1 fix path). */
function applyKeywordFix(
  doc: ResumeDocument,
  critiques: Critique[],
  records: ProfileRecord[],
): ResumeDocument {
  const kw = critiques.find((c) => c.subScore === 'keywords');
  if (!kw) return doc;
  return applySkillsFix(
    doc,
    [{ subScore: 'skills', message: kw.message, targetSectionKey: 'skills' }],
    records,
  );
}

/** Mechanical formatting repairs — no judgment needed, so no model call. */
function sanitizeText(doc: ResumeDocument): ResumeDocument {
  // Tolerates a non-string. The types say every one of these is a string, but the
  // document is assembled from JSONB read back with a cast, so a record missing a field
  // used to arrive here as `undefined` and take the entire draft down at the first
  // `.replace` — after the model work was already paid for. Losing one line is
  // recoverable; losing the resume is not.
  const clean = (s: string): string =>
    (typeof s === 'string' ? s : '')
      .replace(/[►◆★➤▪▸●■◦‣⁃✦✧✱❖]/gu, '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/\t/g, ' ')
      .replace(/(\d{1,2})\s*\/\s*(\d{4})/g, (_m, mo, yr) => formatDate(`${yr}-${mo}`))
      .replace(/\s{2,}/g, ' ')
      .trim();

  for (const section of doc.sections) {
    section.items = section.items.map((i) => ({ ...i, text: clean(i.text) }));
    for (const g of section.groups ?? []) {
      g.title = clean(g.title);
      if (g.subtitle) g.subtitle = clean(g.subtitle);
      g.items = g.items.map((i) => ({ ...i, text: clean(i.text) }));
    }
  }
  return doc;
}

function replaceBulletText(
  doc: ResumeDocument,
  map: Map<string, string>,
): ResumeDocument {
  if (map.size === 0) return doc;
  for (const section of doc.sections) {
    section.items = section.items.map((i) => ({
      ...i,
      text: map.get(i.text.trim()) ?? i.text,
    }));
    for (const g of section.groups ?? []) {
      g.items = g.items.map((i) => ({ ...i, text: map.get(i.text.trim()) ?? i.text }));
    }
  }
  return doc;
}

/**
 * Bring in a project the posting would recognise, in place of one it would not.
 *
 * Retrieval picks projects once, before the resume exists, and nothing revisited that
 * choice. On the EA analytics posting the profile held a project that mentions
 * regression — a term the posting asks for — and it was not selected, so the keyword gate
 * counted "regression" missing on a resume whose owner demonstrably has it. The Skills
 * fix above cannot reach it either: it only adds terms the profile's tags, skill names or
 * stacks hold, and this one lives in a project's description.
 *
 * So when the gate is short, the unused project that would bring the most missing terms
 * replaces the project on the page that carries the fewest — and only if the page ends up
 * holding more of the posting's terms than it did. Everything moved is the user's own
 * record, rendered exactly as assembly renders it, so this is selection, never writing.
 * One swap per pass keeps each pass's effect measurable.
 */
function applyRecordSwapIn(
  doc: ResumeDocument,
  critiques: Critique[],
  records: ProfileRecord[],
): ResumeDocument {
  if (!critiques.some((c) => c.subScore === 'keywords')) return doc;

  const coverage = scoreKeywordCoverage(doc);
  if (coverage.missing.length === 0) return doc;

  const sectionIndex = doc.sections.findIndex((s) => s.key === 'projects');
  const groups = doc.sections[sectionIndex]?.groups ?? [];
  if (sectionIndex === -1 || groups.length === 0) return doc;

  const used = new Set<string>();
  for (const s of doc.sections) {
    for (const i of s.items) if (i.sourceRecordId) used.add(i.sourceRecordId);
    for (const g of s.groups ?? []) {
      for (const i of g.items) if (i.sourceRecordId) used.add(i.sourceRecordId);
    }
  }

  // The unused project bringing the most missing terms.
  let incoming: { record: ProjectRecord; gains: number } | null = null;
  for (const r of records) {
    if (r.type !== 'project' || used.has(r.id)) continue;
    const text = normalizeForMatch(groupText(projectGroup(r)));
    const gains = coverage.missing.filter((k) => keywordMatches(text, k)).length;
    if (gains > 0 && (!incoming || gains > incoming.gains)) incoming = { record: r, gains };
  }
  if (!incoming) return doc;

  // The project on the page carrying the fewest of the posting's terms; the later one on
  // a tie, because retrieval ranked the earlier ones higher.
  const keywords = doc.jobRequirement?.atsKeywords ?? [];
  let weakest = 0;
  let weakestValue = Infinity;
  groups.forEach((g, i) => {
    const text = normalizeForMatch(groupText(g));
    const value = keywords.filter((k) => keywordMatches(text, k)).length;
    if (value <= weakestValue) {
      weakest = i;
      weakestValue = value;
    }
  });

  const outgoing = groups[weakest];
  const replacement = projectGroup(incoming.record);

  // Not a way to grow the page. A much longer project would trade a keyword for a length
  // violation, and the page trim would then remove something else to pay for it.
  if (wordCount(groupText(replacement)) > wordCount(groupText(outgoing)) * 1.5 + 12) return doc;

  const next = structuredClone(doc);
  next.sections[sectionIndex].groups![weakest] = replacement;

  // Only a swap that leaves the page holding more of the posting than before. The
  // outgoing project may have been the only place a term appeared.
  if (scoreKeywordCoverage(next).matched.length <= coverage.matched.length) return doc;

  // REQ-9.2: the snapshot's list of source records follows what is actually printed.
  const outgoingIds = new Set(outgoing.items.map((i) => i.sourceRecordId).filter(Boolean));
  const outgoingHashes = new Set(
    records.filter((r) => outgoingIds.has(r.id)).map((r) => r.contentHash),
  );
  next.recordHashSnapshot = [
    ...next.recordHashSnapshot.filter((h) => !outgoingHashes.has(h)),
    incoming.record.contentHash,
  ];

  return next;
}

/**
 * A project rendered exactly as ./assemble.ts renders it.
 *
 * Mirrored rather than imported because the assembler builds its groups inline; if that
 * ever changes shape, a swapped-in project would look different from its neighbours, and
 * tests/revise-swap.test.mts compares the two.
 */
function projectGroup(p: ProjectRecord): NonNullable<ResumeSection['groups']>[number] {
  return {
    title: p.name,
    subtitle: p.stack.slice(0, 6).join(', '),
    items: [
      ...(p.description?.trim() ? [{ text: p.description.trim(), sourceRecordId: p.id }] : []),
      ...p.impactMetrics
        .filter((m) => typeof m === 'string' && m.trim())
        .map((m) => ({ text: m.trim(), sourceRecordId: p.id })),
    ],
  };
}

function groupText(g: NonNullable<ResumeSection['groups']>[number]): string {
  return [g.title, g.subtitle ?? '', ...g.items.map((i) => i.text)].join(' ');
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The resume runs past its page — remove what the posting cares least about.
 *
 * The only formatting critique a revision can act on that is not a character swap. See
 * ./fit-page.ts for the order things are removed in and what is never touched; it is a
 * no-op on a resume that is too SHORT, which carries the same rule name.
 */
function applyLengthFix(doc: ResumeDocument, critiques: Critique[]): ResumeDocument {
  const flagged = critiques.some(
    (c) => c.subScore === 'formatting' && c.message.startsWith('plausible-length'),
  );
  return flagged ? trimToPage(doc).document : doc;
}

function allItemTexts(doc: ResumeDocument): string[] {
  const out: string[] = [];
  for (const s of doc.sections) {
    for (const i of s.items) out.push(i.text.trim());
    for (const g of s.groups ?? []) for (const i of g.items) out.push(i.text.trim());
  }
  return out;
}

function extractQuoted(message: string): string | null {
  const m = /"([^"]{10,})"/.exec(message);
  return m ? m[1] : null;
}

function parseListAfterColon(message: string): string[] {
  const idx = message.lastIndexOf(':');
  if (idx === -1) return [];
  return message
    .slice(idx + 1)
    .replace(/\.$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 40);
}
