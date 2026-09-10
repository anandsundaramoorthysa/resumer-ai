/**
 * One improvement pass on a saved resume — the other half of the resumable loop.
 *
 * The draft request runs the quality loop for as long as its 20-second budget allows and
 * saves where it got to on the snapshot (`result.loop`). This picks it up: it hands the
 * saved result back to `runQualityGate` as `resume`, so the first thing it does is the
 * revision the draft ran out of time to make, then scores that, and carries on for as
 * long as this request's own budget allows. The browser calls it again for as long as
 * `loop.canContinue` says another pass could help.
 *
 * Nothing is lost by a pass that goes badly. The loop keeps the best version it has seen,
 * the saved one included, so a revision that lowers the score is simply not kept; and a
 * version that scores better is still refused if it does not render and read back
 * cleanly — the same self-test the first draft passes before anyone can download it.
 */

import type { ProfileRecord, QualityGateResult, ResumeDocument } from '../types';
import { DraftBudget } from '../ai/budget';
import { assertDailyBudget, recordDailyUsage } from '../ai/daily-budget';
import { runQualityGate, type GateOutcome } from '../quality/loop';
import { reviseDocument } from '../generate/revise';
import { renderResumePdf } from '../render/pdf';
import { renderResumeDocx } from '../render/docx';
import { selfTest } from '../render/selftest';
import { gateText, iterationDetail, type DraftRunTrace, type Emit } from './run';

export interface ImproveInput {
  userId: string;
  /** The saved best version — exactly the document `saved` scored. */
  document: ResumeDocument;
  saved: QualityGateResult;
  records: ProfileRecord[];
  trace?: DraftRunTrace;
}

export interface ImproveOutput {
  outcome: GateOutcome;
  /** True only when a better version was produced AND it passed the render check. */
  improved: boolean;
  budget: { calls: number; tokens: number };
}

export async function runImprovePass(input: ImproveInput, emit: Emit): Promise<ImproveOutput> {
  await assertDailyBudget(input.userId);

  const budget = new DraftBudget();
  try {
    return await improve(input, emit, budget);
  } finally {
    const spend = budget.snapshot();
    if (input.trace) input.trace.budget = spend;
    await recordDailyUsage(input.userId, spend);
  }
}

async function improve(
  input: ImproveInput,
  emit: Emit,
  budget: DraftBudget,
): Promise<ImproveOutput> {
  const { document, saved, records } = input;
  const before = saved.overall;

  emit({
    stage: 'score',
    status: 'running',
    message: `Picking up at ${before.toFixed(1)}/10 — revising what the last pass flagged…`,
  });

  const outcome = await runQualityGate({
    document,
    records,
    budget,
    revise: (doc, critiques, b) => reviseDocument(doc, critiques, records, b),
    resume: saved,
    onIteration: (iteration, result) => {
      emit({
        stage: 'score',
        status: 'running',
        message: `Pass ${iteration}: ${gateText(result)}, ${result.overall.toFixed(1)}/10${
          result.passed ? ' ✓' : ''
        }`,
        detail: iterationDetail(iteration, result),
      });
    },
  });

  let improved = outcome.document !== document && outcome.result.overall > before;

  if (improved) {
    const [pdf, docx] = await Promise.all([
      renderResumePdf(outcome.document),
      renderResumeDocx(outcome.document),
    ]);
    const [pdfTest, docxTest] = await Promise.all([
      selfTest(pdf, 'pdf', outcome.document),
      selfTest(docx, 'docx', outcome.document),
    ]);
    // The same bar finalize applies: only a `fail` blocks. A host that cannot run the PDF
    // parser reports that as a warning, and that is a fact about the host, not the resume.
    const failed = [...pdfTest.issues, ...docxTest.issues].some((i) => i.severity === 'fail');
    if (failed) {
      improved = false;
      emit({
        stage: 'score',
        status: 'error',
        message: 'The improved version failed its render check, so the previous version was kept.',
      });
    }
  }

  if (input.trace) {
    input.trace.score = {
      overall: outcome.result.overall,
      keywordCoveragePct: outcome.result.keywordCoveragePct,
      haltReason: outcome.result.haltReason ?? null,
    };
  }

  const r = outcome.result;
  const more = r.loop?.canContinue ?? false;
  emit({
    stage: 'score',
    status: r.passed ? 'done' : more ? 'running' : 'error',
    message: r.passed
      ? `Cleared the bar at ${r.overall.toFixed(1)}/10`
      : improved
        ? `Improved from ${before.toFixed(1)} to ${r.overall.toFixed(1)}/10${more ? ' — continuing' : `. ${r.haltExplanation ?? ''}`}`
        : more
          ? `No gain this pass (${before.toFixed(1)}/10) — trying again from the same version`
          : (r.haltExplanation ?? `Stopped at ${before.toFixed(1)}/10.`),
  });

  return { outcome, improved, budget: budget.snapshot() };
}
