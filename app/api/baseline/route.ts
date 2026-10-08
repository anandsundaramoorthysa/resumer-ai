/**
 * Baseline resume — REQ-6.7.
 *
 * A general-purpose resume with no job attached, for cold applications, referrals, and
 * "just send me your resume" asks. No job means no tailoring and no keyword gate, so
 * the grounded rewrite is skipped entirely: with nothing to tailor toward, rewriting
 * would only move your own wording around for no gain.
 */

import { auth } from '@/auth';
import { assembleResume } from '@/lib/generate/assemble';
import { loadProfileForUser, persistDraft } from '@/lib/server/profile';
import { renderResumePdf } from '@/lib/render/pdf';
import { renderResumeDocx } from '@/lib/render/docx';
import { resumeFileName } from '@/lib/render/filename';
import { selfTest } from '@/lib/render/selftest';
import { scoreFormatting } from '@/lib/quality/formatting';
import { rankRecords, selectTop } from '@/lib/retrieval/rank';
import type { JobRequirement } from '@/lib/types';
import { guardMutation } from '@/lib/server/request-guard';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** A neutral requirement so retrieval has something to rank against. */
const NEUTRAL: JobRequirement = {
  roleTitle: 'Baseline',
  seniority: 'unknown',
  category: 'general',
  requiredSkills: [],
  preferredSkills: [],
  responsibilities: [],
  atsKeywords: [],
  tone: 'neutral',
  confidence: 1,
  flags: [],
};

export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const refused = guardMutation(req, { contentTypes: ['application/json'], maxBytes: 4096 });
  if (refused) return refused;

  const profile = await loadProfileForUser(userId);
  if (profile.records.length === 0) {
    return Response.json(
      { error: 'Your profile is empty — connect your portfolio or add details first.' },
      { status: 400 },
    );
  }

  // 'general' has no domain vocabulary, so the relevance floor is inert here and
  // everything stays eligible. That is the correct behaviour for a baseline.
  const { ranked } = rankRecords(profile.records, NEUTRAL);
  const selected = selectTop(ranked);

  const { document } = await assembleResume({
    userId,
    contact: profile.contact,
    job: null,
    records: selected.length > 0 ? selected : profile.records,
    roles: profile.roles,
    rewrite: false,
  });

  const formatting = scoreFormatting(document);
  const pdf = await renderResumePdf(document);
  const docx = await renderResumeDocx(document);
  const [pdfTest, docxTest] = await Promise.all([
    selfTest(pdf, 'pdf', document),
    selfTest(docx, 'docx', document),
  ]);

  const snapshotId = await persistDraft(userId, {
    document,
    score: {
      keywordGatePassed: true,
      keywordCoveragePct: 1,
      missingKeywords: [],
      formattingScore: formatting.score,
      evidenceScore: 0,
      skillsCompletenessScore: 1,
      overall: 0,
      passed: false,
      iterations: 0,
      critiques: [],
      haltExplanation:
        'Baseline resume — not scored against a job, since there is no posting to match.',
    },
    job: null,
    files: {
      pdf,
      docx,
      pdfName: resumeFileName(document, 'pdf'),
      docxName: resumeFileName(document, 'docx'),
    },
  });

  return Response.json({
    snapshotId,
    formattingScore: formatting.score,
    formattingViolations: formatting.violations,
    selfTestPassed: pdfTest.passed && docxTest.passed,
  });
}
