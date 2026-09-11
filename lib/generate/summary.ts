/**
 * A professional summary written for the job — and checked against the profile.
 *
 * Until now the assembler printed a summary only if the profile already held one, and
 * never composed one: nothing had licence to write a claim the profile does not support
 * (NFR-8). The owner wants one tailored per posting, so this writes it — and the same
 * grounding check the bullet rewrite uses (./grounding.ts) refuses any number or proper
 * noun that is not in the facts it was given. A summary that fails is dropped in favour
 * of the stored one, or none at all; a summary is never worth an invented claim.
 */

import { z } from 'zod';
import { generateStructured } from '../ai/chain';
import { draftCallOptions, type DraftBudget } from '../ai/budget';
import { findUngroundedTokens } from './grounding';
import type { JobRequirement } from '../types';

const MAX_WORDS = 75;

const SummarySchema = z.object({ summary: z.string().max(800) });

const SYSTEM = `You write the professional summary at the top of a resume.

Rules:
- Use ONLY the facts provided. Never add an employer, tool, number, degree, title or achievement that is not in them.
- Two or three sentences, under 70 words, no first-person pronouns.
- Lead with who the candidate is (their education or current work), then the experience and skills most relevant to the job, then what they bring to it.
- Use the posting's own terms where the facts genuinely support them — that is what an ATS scans for.
- Plain, confident, specific. No clichés ("passionate", "results-driven", "go-getter").`;

/**
 * What a summary may name: the profile's facts, plus the job it is written for. Naming the
 * target role ("a Product Analyst internship") is not a claim about the candidate — it was
 * refused as "Analyst" because no profile mentions the job it is applying to. The posting's
 * skills are NOT added: claiming one the profile lacks is exactly what this check refuses.
 */
export function summaryGroundingSource(facts: string, job: JobRequirement): string {
  return `${facts}\n${job.roleTitle}\n${job.company ?? ''}`;
}

/**
 * The summary with every sentence that fails grounding removed — or null if none survive.
 *
 * Sentence by sentence, because the posting's terms are now checked too (./grounding.ts),
 * and a summary is where the model most wants to use them: the EA draft's last sentence,
 * "Ready to deliver data-driven insights on player behavior, engagement, and monetization",
 * names three things the profile never mentions. Refusing the whole summary for that
 * would throw away two true sentences with it. Every sentence kept is checked on its own,
 * so this is still the guarantee, not a relaxation of it.
 *
 * A stop ends a sentence only after a word with no dot of its own, so "M.Sc. Data
 * Science" stays one sentence while "Python and SQL. Ready…" is two.
 */
export function groundedSentences(
  text: string,
  source: string,
  postingTerms: readonly string[],
): string | null {
  const kept = text
    .split(/(?<=(?:^|\s)[^\s.]{2,}[.!?])\s+(?=[A-Z])/)
    .filter((s) => findUngroundedTokens(s, source, postingTerms).length === 0);
  return kept.length > 0 ? kept.join(' ') : null;
}

export async function draftSummary(args: {
  job: JobRequirement;
  /** Everything the summary may draw on, as plain text. Also what it is checked against. */
  facts: string;
  budget?: DraftBudget;
}): Promise<string | null> {
  try {
    const { data } = await generateStructured({
      schema: SummarySchema,
      system: SYSTEM,
      prompt: `JOB: ${args.job.roleTitle}${args.job.company ? ` at ${args.job.company}` : ''}
Terms the posting uses: ${args.job.atsKeywords.slice(0, 20).join(', ')}

CANDIDATE FACTS:
${args.facts}`,
      options: draftCallOptions(args.budget, { temperature: 0.3 }),
    });
    const text = data.summary.replace(/\s+/g, ' ').trim();
    if (!text || text.split(' ').length > MAX_WORDS) {
      console.warn('[summary] dropped: empty or too long —', text.split(' ').length, 'words');
      return null;
    }
    const kept = groundedSentences(text, summaryGroundingSource(args.facts, args.job), args.job.atsKeywords);
    if (kept !== text) {
      // Logged, because a missing summary is otherwise silent: the resume simply has none.
      console.warn('[summary] grounding removed', kept ? 'a sentence' : 'the whole summary');
    }
    return kept;
  } catch (err) {
    // A missing summary is not a failed resume — but it is worth knowing why.
    console.warn('[summary] call failed:', err instanceof Error ? `${err.name}: ${err.message}` : err);
    return null;
  }
}
