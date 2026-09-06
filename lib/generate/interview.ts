/**
 * Interview question prep — REQ-4.5.
 *
 * Reuses the JobRequirement and the generated resume, so no new extraction is needed.
 * The genuinely useful part isn't a generic question list — it's knowing which of your
 * own bullets answers each question, and being told plainly where you have nothing to
 * point at. That second category is what the quality gate already surfaces as a real
 * gap, and it's exactly what gets probed in an interview.
 */

import { z } from 'zod';
import type { JobRequirement, ResumeDocument } from '../types';
import { generateStructured } from '../ai/chain';
import type { DraftBudget } from '../ai/budget';

const PrepSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      why: z.string().describe('What the posting says that makes this likely'),
      yourEvidence: z
        .string()
        .describe('The specific bullet from the resume that answers it, quoted. Empty if none exists.'),
      category: z.enum(['technical', 'behavioural', 'role-fit', 'gap-probe']),
    }),
  ),
});

export interface InterviewPrep {
  questions: Array<{
    question: string;
    why: string;
    yourEvidence: string;
    category: 'technical' | 'behavioural' | 'role-fit' | 'gap-probe';
    hasEvidence: boolean;
  }>;
  gapQuestions: number;
}

const SYSTEM = `You predict interview questions for a specific role, and match each one to evidence from the candidate's actual resume.

Rules:
- Base questions on what the job posting actually asks for, not on generic interview advice.
- For yourEvidence, quote the relevant resume line verbatim. If the resume contains nothing that answers the question, return an empty string — do not invent an answer or stretch an unrelated bullet to fit.
- Mark a question 'gap-probe' when the posting requires something the resume does not evidence. These are the ones worth preparing for, so identify them honestly rather than avoiding them.
- 8 to 12 questions. Prefer specific over generic.`;

export async function generateInterviewPrep(
  doc: ResumeDocument,
  job: JobRequirement,
  budget?: DraftBudget,
): Promise<InterviewPrep> {
  const resumeText = doc.sections
    .map((s) =>
      [
        s.heading,
        ...s.items.map((i) => i.text),
        ...(s.groups ?? []).flatMap((g) => [g.title, ...g.items.map((i) => i.text)]),
      ].join('\n'),
    )
    .join('\n\n');

  const { data } = await generateStructured({
    schema: PrepSchema,
    system: SYSTEM,
    prompt: [
      `ROLE: ${job.roleTitle}${job.company ? ` at ${job.company}` : ''} (${job.seniority})`,
      `REQUIRED: ${job.requiredSkills.join(', ')}`,
      `PREFERRED: ${job.preferredSkills.join(', ')}`,
      `RESPONSIBILITIES: ${job.responsibilities.slice(0, 8).join('; ')}`,
      '',
      'CANDIDATE RESUME:',
      resumeText,
    ].join('\n'),
    options: { budget, temperature: 0.3 },
  });

  const questions = data.questions.map((q) => ({
    ...q,
    hasEvidence: q.yourEvidence.trim().length > 0,
  }));

  return {
    questions,
    gapQuestions: questions.filter((q) => !q.hasEvidence).length,
  };
}
