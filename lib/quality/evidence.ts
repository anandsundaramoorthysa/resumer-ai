/**
 * Evidence quality — REQ-5.2 (weight 0.30).
 *
 * The ONE sub-score that needs semantic judgment, so the only one that costs a model
 * call. Everything else in the gate is deterministic. Routed at the 'fast' tier because
 * this runs on every loop iteration.
 *
 * What it measures: does each bullet carry tool/action + scale + outcome, or is it a
 * bare keyword drop? Keyword-stuffed bullets with no supporting evidence score worse on
 * modern parsers, so this is the sub-score that pushes drafts toward real substance.
 */

import { z } from 'zod';
import type { ResumeDocument, SectionKey } from '../types';
import { generateStructured } from '../ai/chain';
import { draftCallOptions, type DraftBudget } from '../ai/budget';

const EvidenceSchema = z.object({
  overallScore: z
    .number()
    .min(0)
    .max(1)
    .describe('0..1 — proportion of bullets carrying real, specific evidence'),
  weakBullets: z
    .array(
      z.object({
        sectionKey: z.string().describe('summary|skills|experience|projects|...'),
        itemIndex: z.number().int().min(0),
        text: z.string(),
        problem: z
          .string()
          .describe('What is missing: scale, outcome, specificity, or all three'),
      }),
    )
    .describe('Bullets that name a tool or duty but show no measurable result'),
});

export interface EvidenceResult {
  score: number;
  weakBullets: Array<{
    sectionKey: SectionKey;
    itemIndex: number;
    text: string;
    problem: string;
  }>;
  provider: string;
}

const SYSTEM = `You grade resume bullets for EVIDENCE QUALITY only. You do not rewrite, and you do not judge formatting or keyword usage.

A strong bullet shows: a concrete action, the scale it happened at, and a measurable outcome.
  Strong: "Optimized PostgreSQL queries serving 200K daily requests, cutting p95 latency 40%"
  Weak:   "Responsible for database optimization using PostgreSQL"

Grade what is actually written. Do not speculate about what the person might have done, and never suggest inventing numbers — a bullet with no metric available is weak, and saying so is correct.

A line ending in [ALREADY REVISED] has been through a revision pass that could not strengthen it from the facts available. Grade it exactly as you find it — it is still weak if it is weak — but do NOT return it in weakBullets. Reporting it again cannot lead to anything except the same rewrite being attempted and rejected a second time.`;

/** The marker the system prompt refers to. Deliberately loud and unlikely in real text. */
const TRIED_MARKER = ' [ALREADY REVISED]';

export async function scoreEvidence(
  doc: ResumeDocument,
  budget?: DraftBudget,
  /**
   * Bullets a previous iteration already sent for a rewrite that came back unusable.
   *
   * Without this the scorer had no memory: the same three bullets that cannot be
   * strengthened without inventing a metric were flagged on every iteration, revised
   * against every iteration, and rejected by the grounding check every time — the loop's
   * most reliable way to spend a model call on a question it had already answered.
   */
  alreadyTried: readonly string[] = [],
): Promise<EvidenceResult> {
  const tried = new Set(alreadyTried.map((t) => t.trim()).filter(Boolean));
  const mark = (text: string) => (tried.has(text.trim()) ? `${text}${TRIED_MARKER}` : text);

  const payload = doc.sections
    .filter((s) => s.key === 'experience' || s.key === 'projects' || s.key === 'summary')
    .map((s) => {
      const flat: string[] = [];
      s.items.forEach((it, i) => flat.push(`  [${i}] ${mark(it.text)}`));
      (s.groups ?? []).forEach((g) => {
        g.items.forEach((it, i) => flat.push(`  [${g.title} #${i}] ${mark(it.text)}`));
      });
      return `SECTION ${s.key}:\n${flat.join('\n')}`;
    })
    .join('\n\n');

  if (!payload.trim()) {
    return { score: 1, weakBullets: [], provider: 'n/a' };
  }

  const { data, provider } = await generateStructured({
    schema: EvidenceSchema,
    system: SYSTEM,
    prompt: `Grade the evidence quality of these resume bullets.\n\n${payload}`,
    options: draftCallOptions(budget, { tier: 'fast', temperature: 0.1 }),
  });

  return {
    score: clamp01(data.overallScore),
    // The instruction above is a request; this is the guarantee. A model that reports a
    // marked bullet anyway does not get to spend another revision pass on it.
    weakBullets: data.weakBullets
      .map((w) => ({
        sectionKey: w.sectionKey as SectionKey,
        itemIndex: w.itemIndex,
        text: w.text.replace(TRIED_MARKER, '').trim(),
        problem: w.problem,
      }))
      .filter((w) => !tried.has(w.text)),
    provider,
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}
