/**
 * The end-to-end draft pipeline — the spine of the product.
 *
 *   assessment (runAssessment):  sync -> understand -> fit
 *   draft (runDraftPipeline):    [sync -> understand] -> retrieve -> draft -> score(loop) -> finalize
 *
 * Two entry points, because a draft is now two requests. The first reads the job and
 * judges whether the profile fits it (lib/fit/agent.ts); the second, started only when
 * the fit is good or the user says "draft it anyway", writes the resume from the job the
 * first one already read. Splitting them is what keeps each inside Netlify's 30-second
 * limit, and it hands the 4–7 seconds that reading the job costs back to the revision
 * loop. The draft can still read the job itself when called without an assessment — the
 * scripts and any direct caller keep working unchanged.
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
import { DRAFT_BUDGET, DraftBudget } from '../ai/budget';
import { assertDailyBudget, recordDailyUsage } from '../ai/daily-budget';
import { AllProvidersFailedError } from '../ai/chain';
import { BudgetExceededError } from '../ai/budget';
import { extractJobRequirement } from '../intake/extract';
import { combineJobText } from '../intake/job-input';
import { looksLikeUrl, scrapeJobUrl } from '../intake/scrape';
import { rankRecords, selectTop } from '../retrieval/rank';
import { assembleResume } from '../generate/assemble';
import { trimToPage } from '../generate/fit-page';
import { reviseDocument } from '../generate/revise';
import { runQualityGate } from '../quality/loop';
import { renderResumePdf } from '../render/pdf';
import { renderResumeDocx } from '../render/docx';
import { selfTest, verifiedMessage } from '../render/selftest';
import { resumeFileName } from '../render/filename';
import { gatherFitFacts } from '../fit/assess';
import { runFitAgent, type FitReport } from '../fit/agent';
import type { EnrichmentSignal } from '../profile/enrichment';

export type Emit = (event: Omit<PipelineEvent, 'at'>) => void;

/**
 * What this run did, filled in as it happens — the only thing a failed draft leaves.
 *
 * `PipelineOutput` is returned, so a run that throws returns nothing, and until now that
 * meant a failure left behind a `console.error` line and a counter increment. Yet by the
 * time most failures happen the run already knows things worth keeping: which job it was
 * drafting for, what it scored before the gate gave up, and — always — what it spent.
 * Those facts are written here as they are learned, into an object the caller owns, so
 * they survive the throw.
 *
 * Two of them are deliberately NOT on the `emit` stream even though they are known at the
 * same moment. Everything emitted is relayed straight to the browser by
 * app/api/draft/route.ts; spend figures and the rewrite outcome are for the owner's own
 * records, and the rule that route states about developer-facing detail is easiest to
 * keep by never putting such detail on the channel that reaches the user in the first
 * place. See lib/db/schema.ts on `draft_run` for what the caller does with this.
 */
export interface DraftRunTrace {
  budget: { calls: number; tokens: number };
  job: { roleTitle: string; company: string } | null;
  score: { overall: number; keywordCoveragePct: number; haltReason: string | null } | null;
  rewrite: { attempted: number; fallbacks: number; reason: 'none' | 'grounding' | 'call-failed' };
}

export function newDraftRunTrace(): DraftRunTrace {
  return {
    budget: { calls: 0, tokens: 0 },
    job: null,
    score: null,
    rewrite: { attempted: 0, fallbacks: 0, reason: 'none' },
  };
}

export interface PipelineInput {
  userId: string;
  contact: ContactInfo;
  records: ProfileRecord[];
  roles: RoleRecord[];
  jobInput: string;
  /** Text already extracted, server-side, from an attached PDF/DOCX job description. */
  jobFileText?: string;
  /** Shown to the user and named in the combined text so the model knows what it is. */
  jobFileName?: string;
  /** Runs before anything else; returns a human-readable summary line. */
  syncStep?: () => Promise<{ summary: string; records?: ProfileRecord[] }>;
  /**
   * Optional. Filled in as the run proceeds so a caller that persists a record of the
   * attempt has something to persist when the attempt throws — see `DraftRunTrace`.
   * Callers that only want a resume (scripts/e2e-draft.mts, the dev route) omit it.
   */
  trace?: DraftRunTrace;
  /**
   * The job as a fit assessment already read it (app/api/draft/assess). When present the
   * posting is not read again — there is no posting text to read anyway, since it was
   * never stored — and those seconds go to the revision loop instead.
   */
  job?: JobRequirement;
  /** The verdict that came with it, carried through so the snapshot can keep it. */
  fit?: FitReport;
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
  /**
   * What this draft could not evidence, per record — see lib/profile/enrichment.ts.
   *
   * Returned rather than written, for the same reason the snapshot is: this module runs
   * the engine and touches no tables. The caller that already persists the draft
   * persists the questions, and a caller that only wants a resume (scripts/e2e-draft.mts,
   * the dev route) gets the signal and ignores it without leaving rows behind.
   */
  enrichment: EnrichmentSignal;
  /** The fit verdict this draft was started under, when there was one. */
  fit: FitReport | null;
}

/**
 * The daily spend gate, wrapped around the run.
 *
 * `DraftBudget` bounds one generation; nothing bounded how many generations. A script
 * calling /api/draft in a loop stayed inside every per-draft limit and still spent
 * without end across all five providers, because the daily counter the design called for
 * was declared in the schema and then never read or written by anything.
 *
 * Recording happens in a `finally`, so a draft that fails halfway — or halts at the
 * quality gate, or runs out of time — still counts the tokens it burned. Charging only
 * for successful runs would be precisely backwards: failures are what a runaway loop
 * produces.
 */
export async function runDraftPipeline(
  input: PipelineInput,
  emit: Emit,
): Promise<PipelineOutput> {
  await assertDailyBudget(input.userId);

  const budget = new DraftBudget();
  try {
    return await runDraft(input, emit, budget);
  } finally {
    const spend = budget.snapshot();
    // Same `finally`, same reason as the daily counter above: a run that failed halfway
    // still spent what it spent, and "how much did the failures cost" was previously a
    // question only the daily aggregate could answer, and only for the whole day at once.
    if (input.trace) input.trace.budget = spend;
    await recordDailyUsage(input.userId, spend);
  }
}

/* ------------------------------------------------------------ assessment -- */

/**
 * What a fit check keeps back from its clock — just enough to seal and send the result.
 *
 * Every draft-path call holds back RENDER_RESERVE_MS (5 seconds in production) so the
 * draft can still build its PDF and DOCX after the last model call. The fit check
 * inherited that and renders nothing. Measured against the real EA job description:
 * reading the job took 8.2s, the fit call was then given 6.7s for work that takes 7–9,
 * timed out, and fell back to the rules-only report — with 5 seconds of its budget still
 * unspent. The same job, when reading it took 5.9s, got the full review.
 */
export const ASSESS_RESERVE_MS = 1_500;

/**
 * The fit check's own clock — longer than a draft's, because it renders nothing.
 *
 * A draft's 20 seconds (MAX_DRAFT_SECONDS) has to leave room for building and checking a
 * PDF and a DOCX before Netlify's 30-second kill; the fit check has no such tail, and it
 * needs the room: reading the job takes 3–8 seconds and the fit call 10 or more. 22
 * seconds, plus the ~3 seconds spent loading the profile before the clock starts, keeps
 * the whole request near 25 — inside the platform limit with margin. Overridable with
 * MAX_ASSESS_SECONDS for a host with a different limit.
 */
export const ASSESS_TIME_BUDGET_MS = (() => {
  const seconds = Number(process.env.MAX_ASSESS_SECONDS);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 22) * 1000;
})();

export interface AssessmentOutput {
  job: JobRequirement;
  fit: FitReport;
  /** The profile as the sync left it, for a caller that wants to show counts. */
  records: ProfileRecord[];
  budget: { calls: number; tokens: number };
}

/**
 * Read the job and judge the fit — and stop there.
 *
 * The caller decides what happens next from `fit.decision`: draft straight away, or ask.
 * Nothing is written anywhere by this function; the result travels to the browser sealed
 * (lib/fit/token.ts) so a fit check the user declines leaves nothing behind.
 *
 * Under the same daily budget as a draft. A fit check costs model calls too, and a loop
 * of fit checks is as much a runaway as a loop of drafts.
 */
export async function runAssessment(
  input: Omit<PipelineInput, 'job' | 'fit'>,
  emit: Emit,
): Promise<AssessmentOutput> {
  await assertDailyBudget(input.userId);

  const budget = new DraftBudget(DRAFT_BUDGET, ASSESS_TIME_BUDGET_MS, ASSESS_RESERVE_MS);
  try {
    const records = await syncProfile(input, emit);
    const { job, jobText } = await readJob(input, emit, budget);

    emit({
      stage: 'fit',
      status: 'running',
      message: `Checking how your profile fits ${job.roleTitle}…`,
    });
    const facts = gatherFitFacts({ job, records, roles: input.roles, contact: input.contact });
    const fit = await runFitAgent({ job, jobText, facts, budget });

    emit({
      stage: 'fit',
      status: 'done',
      message: fit.headline,
      detail: { verdict: fit.verdict, score: fit.score, decision: fit.decision },
    });

    return { job, fit, records, budget: budget.snapshot() };
  } finally {
    const spend = budget.snapshot();
    if (input.trace) input.trace.budget = spend;
    await recordDailyUsage(input.userId, spend);
  }
}

/* ------------------------------------------------------------------ draft -- */

async function runDraft(
  input: PipelineInput,
  emit: Emit,
  budget: DraftBudget,
): Promise<PipelineOutput> {
  // An assessed draft was synced seconds ago, by the assessment. Doing it again would be a
  // GitHub round trip that cannot find anything new.
  const records = input.job
    ? (emit({ stage: 'sync', status: 'done', message: 'Using the profile the fit check just read.' }),
      input.records)
    : await syncProfile(input, emit);

  let job: JobRequirement;
  if (input.job) {
    job = input.job;
    if (input.trace) input.trace.job = { roleTitle: job.roleTitle, company: job.company ?? '' };
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
  } else {
    ({ job } = await readJob(input, emit, budget));
  }

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

  if (input.trace) {
    input.trace.rewrite = {
      attempted: assembled.rewriteFallback.attempted,
      fallbacks: assembled.rewriteFallback.count,
      reason: assembled.rewriteFallback.reason,
    };
  }

  // The assembler only ever drops whole tail sections to fit the page, so a large profile
  // went straight past it — 50 lines against a page of 29 on the EA drafts, failing the
  // length rule before anything else was judged. See ../generate/fit-page.ts.
  const trimmed = trimToPage(assembled.document);

  // A section cut for space is reported, not silently omitted — otherwise the only way
  // to discover that Languages is missing is to notice it isn't there.
  //
  // The fallback note now splits on WHY the wording was kept. It used to say one thing
  // for both causes, and that one thing was a claim about the user's profile — "a rewrite
  // would have added something not in your profile" — printed verbatim on runs where no
  // rewrite was ever judged because the provider threw. Telling someone their experience
  // is too thin to rephrase, because a request timed out, is the worst version of this
  // message; see `rewriteFallback` in lib/generate/assemble.ts.
  const fallbackNote =
    assembled.rewriteFallback.count === 0
      ? ''
      : assembled.rewriteFallback.reason === 'call-failed'
        ? `used your own wording throughout — the rephrasing step didn't answer this time`
        : `kept your original wording on ${assembled.rewriteFallback.count} bullet(s) where a rewrite would have added something not in your profile`;

  const draftNotes = [
    fallbackNote,
    assembled.droppedForSpace.length > 0
      ? `left off ${assembled.droppedForSpace.join(', ')} to keep it to the page`
      : '',
    trimmed.removed.length > 0
      ? `trimmed ${trimmed.removed.length} lower-priority item(s) so it fits the page`
      : '',
  ].filter(Boolean);

  emit({
    stage: 'draft',
    status: 'done',
    message:
      draftNotes.length > 0
        ? `First draft ready · ${draftNotes.join(' · ')}`
        : 'First draft ready',
    detail: {
      ...assembled.rewriteStats,
      // The slug, not the provider's error text. This detail object is relayed verbatim
      // to the browser by app/api/draft/route.ts, so only the classification travels.
      fallbackReason: assembled.rewriteFallback.reason,
      droppedForSpace: assembled.droppedForSpace,
      trimmedForSpace: trimmed.removed,
    },
  });

  // ---------------------------------------------------------------- 5. score --
  emit({ stage: 'score', status: 'running', message: 'Scoring against ATS criteria…' });
  const outcome = await runQualityGate({
    document: trimmed.document,
    records,
    budget,
    revise: (doc, critiques, b) => reviseDocument(doc, critiques, records, b),
    onIteration: (iteration, result) => {
      emit({
        stage: 'score',
        status: 'running',
        message: `Attempt ${iteration}: ${gateText(result)}, ${result.overall.toFixed(1)}/10${
          result.passed ? ' ✓' : ' — revising'
        }`,
        detail: iterationDetail(iteration, result),
      });
    },
  });

  // Before the finalize stage, which is where two of the six production faults lived: a
  // run that dies rendering still records what it scored.
  if (input.trace) {
    input.trace.score = {
      overall: outcome.result.overall,
      keywordCoveragePct: outcome.result.keywordCoveragePct,
      haltReason: outcome.result.haltReason ?? null,
    };
  }

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
      canContinue: outcome.result.loop?.canContinue ?? false,
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
        ? verifiedMessage(pdfTest, docxTest)
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
    /*
     * The three things this run could not evidence, collected in one place.
     *
     * Every field here already existed and was already discarded: `rejected` became a
     * sentence in the draft note, `weakBullets` became critiques the revision pass could
     * not act on, and `genuineGaps` became one clause of the halt explanation. Gathering
     * them costs nothing — no extra model call, no extra query — because the run has
     * already paid for all three.
     */
    enrichment: {
      rejectedRewrites: assembled.rejectedRewrites,
      weakBullets: outcome.weakBullets,
      genuineGaps: outcome.genuineGaps,
      document,
      job,
    },
    fit: input.fit ?? null,
  };
}

/* ---------------------------------------------------------- shared steps -- */

async function syncProfile(
  input: Pick<PipelineInput, 'records' | 'syncStep'>,
  emit: Emit,
): Promise<ProfileRecord[]> {
  emit({ stage: 'sync', status: 'running', message: 'Checking your portfolio for updates…' });
  if (!input.syncStep) {
    emit({ stage: 'sync', status: 'done', message: 'Using your saved profile.' });
    return input.records;
  }
  try {
    const result = await input.syncStep();
    emit({ stage: 'sync', status: 'done', message: result.summary });
    return result.records ?? input.records;
  } catch (err) {
    // A sync failure is non-fatal: draft from what we already have, but say so.
    emit({
      stage: 'sync',
      status: 'error',
      message: `Couldn't refresh from GitHub (${short(err)}). Drafting from your saved profile instead.`,
    });
    return input.records;
  }
}

async function readJob(
  input: Pick<PipelineInput, 'jobInput' | 'jobFileText' | 'jobFileName' | 'trace'>,
  emit: Emit,
  budget: DraftBudget,
): Promise<{ job: JobRequirement; jobText: string }> {
  emit({ stage: 'understand', status: 'running', message: 'Reading the job…' });

  // The scrape decision is made on the typed text alone, before the attachment is
  // folded in. A bare URL only looks like a URL while it is the whole input, so
  // combining first would silently turn "link + file" into "never scraped".
  let jobText = input.jobInput.trim();
  if (jobText && looksLikeUrl(jobText)) {
    const scraped = await scrapeJobUrl(jobText);
    if (scraped.ok) {
      jobText = scraped.text;
      emit({ stage: 'understand', status: 'running', message: 'Fetched the posting. Reading it…' });
    } else {
      emit({ stage: 'understand', status: 'error', message: scraped.message });
      throw new PipelineError(scraped.message, 'needs-paste');
    }
  }

  const fileText = input.jobFileText?.trim() ?? '';
  if (fileText) {
    emit({
      stage: 'understand',
      status: 'running',
      message: input.jobFileName
        ? `Read ${input.jobFileName} (${fileText.length.toLocaleString()} characters).`
        : 'Read the attached document.',
    });
  }

  const combined = combineJobText(jobText, fileText, input.jobFileName);
  jobText = combined.text;
  if (combined.truncated) {
    emit({
      stage: 'understand',
      status: 'running',
      message: 'The attached document was longer than the input limit and was read up to the cap.',
    });
  }

  let job: JobRequirement;
  try {
    job = await extractJobRequirement(jobText, budget);
  } catch (err) {
    emit({ stage: 'understand', status: 'error', message: describeAiError(err) });
    throw err;
  }

  // Recorded before the event, so a run that dies in retrieval still names the job it
  // died drafting for. "The draft failed" and "the draft for the Semrush SEO lead role
  // failed" are different amounts of information.
  if (input.trace) input.trace.job = { roleTitle: job.roleTitle, company: job.company ?? '' };

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

  return { job, jobText };
}

export function gateText(result: QualityGateResult): string {
  return result.keywordGatePassed
    ? `keyword gate passed (${Math.round(result.keywordCoveragePct * 100)}%)`
    : `keyword gate ${Math.round(result.keywordCoveragePct * 100)}% — below 70%`;
}

export function iterationDetail(iteration: number, result: QualityGateResult) {
  return {
    iteration,
    overall: result.overall,
    keywordCoveragePct: result.keywordCoveragePct,
    formatting: result.formattingScore,
    evidence: result.evidenceScore,
    skills: result.skillsCompletenessScore,
    passed: result.passed,
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

export function describeAiError(err: unknown): string {
  // Not err.message. That names every provider and quotes its raw error — written for a
  // developer — and this string goes straight into a progress row the user reads, where
  // it showed "Every configured AI provider failed: Gemini (This model is currently
  // experiencing high demand…". Nothing diagnostic is lost: the caller rethrows the
  // original error and the route logs it in full, attempts and all, which is the log
  // line that found the overload gap in the first place.
  if (err instanceof AllProvidersFailedError) {
    return 'The AI providers are busy or unavailable right now. Nothing was saved — try again in a minute.';
  }
  if (err instanceof BudgetExceededError) return err.message;
  return `Something went wrong: ${short(err)}`;
}

function short(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}
