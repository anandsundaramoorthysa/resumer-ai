/**
 * The end-to-end draft pipeline — the spine of the product.
 *
 *   sync -> understand -> retrieve -> draft -> score(loop) -> finalize
 *
 * Emits a PipelineEvent at every real transition (REQ-8.1). Nothing here reports a
 * stage as done unless it actually finished, and any stage that throws surfaces as an
 * explicit error event rather than a silent hang (REQ-10.2 / design.md §5).
 */

import type {
  ContactInfo,
  JobRequirement,
  PipelineEvent,
  ProfileRecord,
  QualityGateResult,
  ResumeDocument,
  RoleRecord,
} from '../types';
import { DraftBudget } from '../ai/budget';
import { AllProvidersFailedError } from '../ai/chain';
import { BudgetExceededError } from '../ai/budget';
import { extractJobRequirement } from '../intake/extract';
import { looksLikeUrl, scrapeJobUrl } from '../intake/scrape';
import { rankRecords, selectTop } from '../retrieval/rank';
import { assembleResume } from '../generate/assemble';
import { reviseDocument } from '../generate/revise';
import { runQualityGate } from '../quality/loop';
import { renderResumePdf } from '../render/pdf';
import { renderResumeDocx } from '../render/docx';
import { selfTest } from '../render/selftest';
import { resumeFileName } from '../render/filename';

export type Emit = (event: Omit<PipelineEvent, 'at'>) => void;

export interface PipelineInput {
  userId: string;
  contact: ContactInfo;
  records: ProfileRecord[];
  roles: RoleRecord[];
  jobInput: string;
  /** Runs before anything else; returns a human-readable summary line. */
  syncStep?: () => Promise<{ summary: string; records?: ProfileRecord[] }>;
}

export interface PipelineOutput {
  document: ResumeDocument;
  score: QualityGateResult;
  job: JobRequirement | null;
  files: {
    pdf: Buffer;
    docx: Buffer;
    pdfName: string;
    docxName: string;
  };
  selfTest: { pdfPassed: boolean; docxPassed: boolean; issues: string[] };
  budget: { calls: number; tokens: number };
}

export async function runDraftPipeline(
  input: PipelineInput,
  emit: Emit,
): Promise<PipelineOutput> {
  const budget = new DraftBudget();
  let records = input.records;

  // ---------------------------------------------------------------- 1. sync --
  emit({ stage: 'sync', status: 'running', message: 'Checking your portfolio for updates…' });
  if (input.syncStep) {
    try {
      const result = await input.syncStep();
      if (result.records) records = result.records;
      emit({ stage: 'sync', status: 'done', message: result.summary });
    } catch (err) {
      // A sync failure is non-fatal: draft from what we already have, but say so.
      emit({
        stage: 'sync',
        status: 'error',
        message: `Couldn't refresh from GitHub (${short(err)}). Drafting from your saved profile instead.`,
      });
    }
  } else {
    emit({ stage: 'sync', status: 'done', message: 'Using your saved profile.' });
  }

  // ----------------------------------------------------------- 2. understand --
  emit({ stage: 'understand', status: 'running', message: 'Reading the job…' });

  let jobText = input.jobInput.trim();
  if (looksLikeUrl(jobText)) {
    const scraped = await scrapeJobUrl(jobText);
    if (scraped.ok) {
      jobText = scraped.text;
      emit({ stage: 'understand', status: 'running', message: 'Fetched the posting. Reading it…' });
    } else {
      emit({ stage: 'understand', status: 'error', message: scraped.message });
      throw new PipelineError(scraped.message, 'needs-paste');
    }
  }

  let job: JobRequirement;
  try {
    job = await extractJobRequirement(jobText, budget);
  } catch (err) {
    emit({ stage: 'understand', status: 'error', message: describeAiError(err) });
    throw err;
  }

  emit({
    stage: 'understand',
    status: 'done',
    message: `${job.roleTitle}${job.company ? ` at ${job.company}` : ''} · ${job.seniority} · ${job.atsKeywords.length} keywords`,
    detail: {
      roleTitle: job.roleTitle,
      company: job.company,
      seniority: job.seniority,
      category: job.category,
      topKeywords: job.atsKeywords.slice(0, 8),
      confidence: job.confidence,
      flags: job.flags,
    },
  });

  // ------------------------------------------------------------- 3. retrieve --
  emit({ stage: 'retrieve', status: 'running', message: 'Finding your most relevant experience…' });
  const { ranked, excluded } = rankRecords(records, job);
  const selected = selectTop(ranked);

  const counts = countByType(selected);
  emit({
    stage: 'retrieve',
    status: 'done',
    message: `Selected ${counts['experience-bullet'] ?? 0} bullets, ${counts.project ?? 0} projects, ${counts.skill ?? 0} skills${
      excluded.length ? ` · set aside ${excluded.length} off-target items` : ''
    }`,
    detail: { counts, excluded: excluded.length },
  });

  // ---------------------------------------------------------------- 4. draft --
  emit({ stage: 'draft', status: 'running', message: 'Drafting your resume…' });
  let assembled;
  try {
    assembled = await assembleResume({
      userId: input.userId,
      contact: input.contact,
      job,
      records: selected,
      roles: input.roles,
      budget,
    });
  } catch (err) {
    emit({ stage: 'draft', status: 'error', message: describeAiError(err) });
    throw err;
  }

  emit({
    stage: 'draft',
    status: 'done',
    message:
      assembled.rewriteStats.rejected > 0
        ? `First draft ready · kept your original wording on ${assembled.rewriteStats.rejected} bullet(s) where a rewrite would have added something not in your profile`
        : 'First draft ready',
    detail: assembled.rewriteStats,
  });

  // ---------------------------------------------------------------- 5. score --
  emit({ stage: 'score', status: 'running', message: 'Scoring against ATS criteria…' });
  const outcome = await runQualityGate({
    document: assembled.document,
    records,
    budget,
    revise: (doc, critiques, b) => reviseDocument(doc, critiques, records, b),
    onIteration: (iteration, result) => {
      const gate = result.keywordGatePassed
        ? `keyword gate passed (${Math.round(result.keywordCoveragePct * 100)}%)`
        : `keyword gate ${Math.round(result.keywordCoveragePct * 100)}% — below 70%`;
      emit({
        stage: 'score',
        status: 'running',
        message: `Attempt ${iteration}: ${gate}, ${result.overall.toFixed(1)}/10${
          result.passed ? ' ✓' : ' — revising'
        }`,
        detail: {
          iteration,
          overall: result.overall,
          keywordCoveragePct: result.keywordCoveragePct,
          formatting: result.formattingScore,
          evidence: result.evidenceScore,
          skills: result.skillsCompletenessScore,
          passed: result.passed,
        },
      });
    },
  });

  emit({
    stage: 'score',
    status: outcome.result.passed ? 'done' : 'error',
    message: outcome.result.passed
      ? `Cleared the bar at ${outcome.result.overall.toFixed(1)}/10 after ${outcome.result.iterations} attempt(s)`
      : (outcome.result.haltExplanation ?? 'Could not reach 8.5/10.'),
    detail: {
      overall: outcome.result.overall,
      passed: outcome.result.passed,
      haltReason: outcome.result.haltReason,
      genuineGaps: outcome.genuineGaps,
      history: outcome.history,
    },
  });

  // ------------------------------------------------------------- 6. finalize --
  emit({ stage: 'finalize', status: 'running', message: 'Building your PDF and DOCX…' });

  const document = outcome.document;
  const pdf = await renderResumePdf(document);
  const docx = await renderResumeDocx(document);

  const [pdfTest, docxTest] = await Promise.all([
    selfTest(pdf, 'pdf', document),
    selfTest(docx, 'docx', document),
  ]);

  const issues = [...pdfTest.issues, ...docxTest.issues]
    .filter((i) => i.severity === 'fail')
    .map((i) => `${i.check}: ${i.detail}`);

  emit({
    stage: 'finalize',
    status: issues.length === 0 ? 'done' : 'error',
    message:
      issues.length === 0
        ? `Both files verified — text extracts cleanly (${pdfTest.extractedChars} chars from the PDF)`
        : `Render check found ${issues.length} problem(s) — see details`,
    detail: { issues, pdfChars: pdfTest.extractedChars, docxChars: docxTest.extractedChars },
  });

  return {
    document,
    score: outcome.result,
    job,
    files: {
      pdf,
      docx,
      pdfName: resumeFileName(document, 'pdf'),
      docxName: resumeFileName(document, 'docx'),
    },
    selfTest: { pdfPassed: pdfTest.passed, docxPassed: docxTest.passed, issues },
    budget: budget.snapshot(),
  };
}

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly kind: 'needs-paste' | 'generic' = 'generic',
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

function countByType(records: ProfileRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) out[r.type] = (out[r.type] ?? 0) + 1;
  return out;
}

function describeAiError(err: unknown): string {
  if (err instanceof AllProvidersFailedError) return err.message;
  if (err instanceof BudgetExceededError) return err.message;
  return `Something went wrong: ${short(err)}`;
}

function short(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}
