/**
 * Cover letter generation — REQ-4.5.
 *
 * Reuses the resume that was already produced rather than starting over: the retrieval
 * and grounding work is done, so the letter is written from bullets that have already
 * been verified against source records. Same rule applies — nothing may appear here that
 * isn't in the resume it was built from (NFR-8).
 */

import { z } from 'zod';
import type { JobRequirement, ResumeDocument } from '../types';
import { generateStructured } from '../ai/chain';
import type { DraftBudget } from '../ai/budget';
import { findUngroundedTokens } from './grounding';

const LetterSchema = z.object({
  greeting: z.string(),
  opening: z.string().describe('Why this role, in one or two sentences'),
  body: z
    .array(z.string())
    .describe('One or two short paragraphs, each anchored to a specific accomplishment'),
  closing: z.string(),
});

export interface CoverLetter {
  greeting: string;
  paragraphs: string[];
  closing: string;
  /** Claims that did not trace back to the resume and were therefore removed. */
  removed: string[];
}

const SYSTEM = `You write short, plain cover letters using ONLY facts from the resume you are given.

Rules:
- Never state an accomplishment, metric, employer, tool or credential that is not in the resume text provided.
- No filler ("I am writing to express my keen interest"), no flattery about the company, no adjectives about yourself that the evidence doesn't earn.
- Three short paragraphs maximum. A hiring manager should be able to read it in under thirty seconds.
- Refer to specific work, not to qualities. "Cut p95 latency 40% on a 200K-request/day service" beats "I am passionate about performance".
- Plain professional English. No em dashes.`;

export async function generateCoverLetter(
  doc: ResumeDocument,
  job: JobRequirement,
  budget?: DraftBudget,
): Promise<CoverLetter> {
  const resumeText = doc.sections
    .map((s) => {
      const lines = [
        ...s.items.map((i) => i.text),
        ...(s.groups ?? []).flatMap((g) => [
          `${g.title}${g.subtitle ? ` at ${g.subtitle}` : ''}${g.dateRange ? ` (${g.dateRange})` : ''}`,
          ...g.items.map((i) => i.text),
        ]),
      ];
      return `${s.heading}\n${lines.join('\n')}`;
    })
    .join('\n\n');

  const { data } = await generateStructured({
    schema: LetterSchema,
    system: SYSTEM,
    prompt: [
      `ROLE: ${job.roleTitle}${job.company ? ` at ${job.company}` : ''} (${job.seniority})`,
      `WHAT THEY ASKED FOR: ${job.requiredSkills.slice(0, 12).join(', ')}`,
      job.companyContext ? `CONTEXT: ${job.companyContext}` : '',
      '',
      'RESUME (the only facts you may use):',
      resumeText,
    ]
      .filter(Boolean)
      .join('\n'),
    options: { budget, temperature: 0.4 },
  });

  // Same verification as the resume: a paragraph that introduces a number or proper
  // noun absent from the resume is dropped rather than shipped.
  const removed: string[] = [];
  const keep = (text: string): boolean => {
    const violations = findUngroundedTokens(text, `${resumeText} ${job.roleTitle} ${job.company ?? ''}`);
    if (violations.length === 0) return true;
    removed.push(`${text.slice(0, 60)}… (unsupported: ${violations.map((v) => v.token).join(', ')})`);
    return false;
  };

  const paragraphs = [data.opening, ...data.body].filter(keep);

  return {
    greeting: data.greeting,
    paragraphs,
    closing: data.closing,
    removed,
  };
}

export function coverLetterToText(letter: CoverLetter, doc: ResumeDocument): string {
  const c = doc.contact;
  const contactLine = [c.fullName, c.email, c.phone].filter(Boolean).join(' | ');
  return [
    contactLine,
    '',
    letter.greeting,
    '',
    ...letter.paragraphs.flatMap((p) => [p, '']),
    letter.closing,
    '',
    c.fullName,
  ].join('\n');
}
