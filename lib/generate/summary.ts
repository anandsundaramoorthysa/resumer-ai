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
import { isGrounded } from './grounding';
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
    if (!text || text.split(' ').length > MAX_WORDS) return null;
    return isGrounded(text, args.facts) ? text : null;
  } catch {
    // A missing summary is not a failed resume.
    return null;
  }
}
