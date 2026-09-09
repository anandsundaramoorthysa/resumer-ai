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
  ResumeDocument,
  SkillRecord,
} from '../types';
import { generateStructured } from '../ai/chain';
import type { DraftBudget } from '../ai/budget';
import { acceptRewriteOrFallback } from './grounding';
import { formatDate } from '../render/dates';
import { holdsKeyword } from '../quality/vocabulary';

const ReviseSchema = z.object({
  revisions: z.array(
    z.object({
      original: z.string(),
      revised: z.string(),
    }),
  ),
});

const REVISE_SYSTEM = `You strengthen weak resume bullets using ONLY the facts already present in each bullet.

A weak bullet names a tool or a duty but shows no scale and no outcome. Strengthen it by making the existing action and its existing result specific and active.

Absolute rules:
- Never add a number, percentage, tool, company, or claim that is not already in the original bullet. If there is no metric in the original, there is no metric in your revision — restructure for clarity instead.
- If a bullet genuinely cannot be improved without inventing something, return it unchanged. That is the correct answer, not a failure.
- One sentence, under 30 words.`;

export async function reviseDocument(
  doc: ResumeDocument,
  critiques: Critique[],
  allRecords: ProfileRecord[],
  budget?: DraftBudget,
): Promise<ResumeDocument> {
  let next: ResumeDocument = structuredClone(doc);

  // ---- 1. Deterministic fixes, no model call --------------------------------
  next = applySkillsFix(next, critiques, allRecords);
  next = applyKeywordFix(next, critiques, allRecords);
  next = sanitizeText(next);

  // ---- 2. Evidence fixes, model-assisted, grounded ---------------------------
  const evidenceTargets = critiques
    .filter((c) => c.subScore === 'evidence')
    .map((c) => extractQuoted(c.message))
    .filter((t): t is string => Boolean(t));

  if (evidenceTargets.length > 0) {
    try {
      const { data } = await generateStructured({
        schema: ReviseSchema,
        system: REVISE_SYSTEM,
        prompt: `Strengthen these bullets. Return each original alongside its revision.\n\n${evidenceTargets
          .map((t, i) => `${i + 1}. ${t}`)
          .join('\n')}`,
        options: { budget, temperature: 0.25 },
      });

      const map = new Map<string, string>();
      for (const r of data.revisions) {
        // Verified against the original, same as first-pass generation.
        const verdict = acceptRewriteOrFallback(r.revised, r.original);
        if (verdict.accepted) map.set(r.original.trim(), verdict.text);
      }
      next = replaceBulletText(next, map);
    } catch {
      // Leave the bullets as they were — a failed revision must not corrupt the draft.
    }
  }

  return next;
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
