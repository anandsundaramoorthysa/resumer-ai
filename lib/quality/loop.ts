/**
 * The quality gate — REQ-5.1 through REQ-5.6.
 *
 *   keyword gate (70%, pass/fail)
 *     -> weighted score: formatting 0.30 + evidence 0.30 + skills 0.40
 *     -> >= 8.5  : done
 *     -> <  8.5  : critique -> targeted revise -> re-score, max 4 iterations
 *     -> exhausted: HONEST FAILURE — best version + why, never a forced pass
 *
 * The invariant that matters most: when the score cannot be reached with real data, the
 * loop stops and says so. It never relaxes the no-fabrication rule to clear the bar
 * (NFR-8). A wording problem gets fixed here; a real experience gap gets reported.
 */

import type {
  Critique,
  ProfileRecord,
  QualityGateResult,
  ResumeDocument,
} from '../types';
import { scoreKeywordCoverage, KEYWORD_GATE_THRESHOLD } from './keywords';
import { scoreFormatting } from './formatting';
import { combinedFormattingScore, scoreLength } from './length';
import { scoreSkillsCompleteness } from './skills';
import { scoreEvidence, type EvidenceResult } from './evidence';
import { BudgetExceededError, type DraftBudget } from '../ai/budget';

export const PASS_THRESHOLD = 8.5;
export const MAX_ITERATIONS = 4;

export const WEIGHTS = {
  formatting: 0.3,
  evidence: 0.3,
  skills: 0.4,
} as const;

export interface ScoreBreakdown {
  result: QualityGateResult;
  /** Gaps that no amount of rewriting can close — surfaced verbatim to the user. */
  genuineGaps: string[];
  /**
   * The evidence grader's own findings, kept structured.
   *
   * They are already flattened into `result.critiques` as `"<text>" — <problem>`, which
   * is the right shape for the revision pass and the wrong one for anything else: the
   * only way back to the section, the index and the problem is to parse the sentence.
   * lib/profile/enrichment.ts needs the problem verbatim to say what is missing and the
   * text to find the record it belongs to, so the structure is carried rather than
   * reconstructed.
   */
  weakBullets: EvidenceResult['weakBullets'];
}

/**
 * How much the overall score has to move for an iteration to have been worth its calls.
 *
 * The evidence sub-score is the only one a model produces, and asking the same model the
 * same question twice moves it by a few hundredths on its own. Below this, the loop is
 * measuring that noise rather than an improvement it caused.
 */
export const MIN_MEANINGFUL_GAIN = 0.05;

/** Consecutive iterations that may fail to move the score before the loop gives up. */
const MAX_STAGNANT_ITERATIONS = 2;

/** One scoring pass. No mutation, no revision — just measurement. */
export async function scoreDocument(
  doc: ResumeDocument,
  records: ProfileRecord[],
  budget?: DraftBudget,
  /** Bullets an earlier revision already proved it cannot strengthen — see evidence.ts. */
  alreadyTried: readonly string[] = [],
): Promise<ScoreBreakdown> {
  const keywords = scoreKeywordCoverage(doc);
  const formatting = scoreFormatting(doc);
  // Length is scored beside the formatting rules rather than among them — see length.ts
  // for why a 180-word resume is a quality defect and not a parsing one (AUDIT #7).
  const length = scoreLength(doc);
  const formattingScore = combinedFormattingScore(formatting, length);
  const skills = scoreSkillsCompleteness(doc, records);

  // Only spend a model call once the cheap deterministic checks are in hand.
  const evidence = await scoreEvidence(doc, budget, alreadyTried);

  const overall =
    (formattingScore * WEIGHTS.formatting +
      evidence.score * WEIGHTS.evidence +
      skills.score * WEIGHTS.skills) *
    10;

  const critiques: Critique[] = [];

  if (!keywords.passed) {
    critiques.push({
      subScore: 'keywords',
      message: `Keyword coverage is ${(keywords.coveragePct * 100).toFixed(0)}% — below the ${(
        KEYWORD_GATE_THRESHOLD * 100
      ).toFixed(0)}% gate. Missing: ${keywords.missing.slice(0, 12).join(', ')}.`,
    });
  }

  // Formatting critiques are kept, and only some of them have a fix path. That is
  // deliberate, so it is worth writing down which.
  //
  // `reviseDocument` repairs four of these rules mechanically and unconditionally, without
  // reading the critique at all: icon glyphs, decorative bullet characters, tabs and
  // numeric dates. The rest — length, the heading allow-list, a missing Skills section, a
  // document with no substance, the contact block, hyperlink text, presentation mode — are
  // decided during assembly or by the profile behind it, and no rewrite of the finished
  // document can close them. Before this change, a document failing on length was told so
  // four times and failed identically each time.
  //
  // They are still emitted rather than suppressed: they are the record of WHY the resume
  // did not clear the bar, they reach the user through the halt explanation, and a
  // critique nobody can act on is still true. What changed is that the loop no longer
  // treats "issues remain" as evidence that another iteration will help — the no-progress
  // halt below is what stops it re-serving these.
  for (const v of [...formatting.violations, ...(length.violation ? [length.violation] : [])]) {
    critiques.push({
      subScore: 'formatting',
      message: `${v.rule}: ${v.detail}`,
      targetSectionKey: v.sectionKey as Critique['targetSectionKey'],
    });
  }

  for (const w of evidence.weakBullets) {
    critiques.push({
      subScore: 'evidence',
      message: `"${w.text}" — ${w.problem}`,
      targetSectionKey: w.sectionKey,
      targetItemIndex: w.itemIndex,
    });
  }

  if (skills.missingButHeld.length > 0) {
    critiques.push({
      subScore: 'skills',
      message: `These are in your profile but missing from the Skills section: ${skills.missingButHeld.join(
        ', ',
      )}.`,
      targetSectionKey: 'skills',
    });
  }

  const result: QualityGateResult = {
    keywordGatePassed: keywords.passed,
    keywordCoveragePct: keywords.coveragePct,
    missingKeywords: keywords.missing,
    formattingScore,
    evidenceScore: evidence.score,
    skillsCompletenessScore: skills.score,
    overall: Number(overall.toFixed(2)),
    passed: keywords.passed && overall >= PASS_THRESHOLD,
    iterations: 0,
    critiques,
  };

  return { result, genuineGaps: skills.genuineGaps, weakBullets: evidence.weakBullets };
}

/**
 * What one revision pass did — the contract between the loop and whatever revises for it.
 *
 * It used to be just a document, so the loop could not tell a real revision from a no-op.
 * On a thin profile a no-op is the common case (no evidence targets, or none whose rewrite
 * survives grounding, and no missing skill the profile actually holds), every
 * deterministic sub-score then came back bit-identical, and only model noise on the
 * evidence score moved at all. Iterations 2 through 4 cost a judge call and a revise call
 * each and could not, by construction, produce anything different.
 *
 * Declared here rather than in `generate/revise.ts` so this module keeps knowing nothing
 * about generation and stays testable with a stub.
 */
export interface ReviseOutcome {
  document: ResumeDocument;
  /** False when the pass handed back a document identical to the one it was given. */
  changed: boolean;
  /**
   * Bullets sent for a rewrite that came back unusable — identical, empty, or rejected by
   * the grounding check. Fed to the next scoring pass so it stops re-flagging them.
   */
  unimprovable: string[];
}

export type ReviseFn = (
  doc: ResumeDocument,
  critiques: Critique[],
  budget?: DraftBudget,
) => Promise<ReviseOutcome>;

export interface GateOutcome {
  document: ResumeDocument;
  result: QualityGateResult;
  genuineGaps: string[];
  /**
   * Every weak bullet any iteration reported, deduplicated by text.
   *
   * Accumulated across the whole loop rather than taken from the winning iteration, and
   * the reason is `unimprovable`: once a revision pass fails on a bullet, the scorer is
   * told to stop reporting it, so the LAST iteration's list is systematically missing
   * exactly the bullets that could not be strengthened from the facts available — which
   * are the ones worth asking the user about. The union restores them.
   */
  weakBullets: ScoreBreakdown['weakBullets'];
  /** Every iteration's score, for the live pipeline readout (REQ-8.1). */
  history: Array<{ iteration: number; overall: number; keywordGatePassed: boolean }>;
}

/**
 * Runs score -> critique -> revise until the bar is cleared or a stop condition hits.
 * `revise` is injected so this module stays free of generation concerns and is testable
 * with a stub.
 */
export async function runQualityGate(args: {
  document: ResumeDocument;
  records: ProfileRecord[];
  revise: ReviseFn;
  budget?: DraftBudget;
  onIteration?: (iteration: number, result: QualityGateResult) => void;
}): Promise<GateOutcome> {
  const { records, revise, budget, onIteration } = args;

  let current = args.document;
  let best: { doc: ResumeDocument; breakdown: ScoreBreakdown } | null = null;
  const history: GateOutcome['history'] = [];

  // Bullets a revision pass has already proved it cannot strengthen. Carried forward so
  // the evidence scorer stops charging for the same verdict every iteration.
  const unimprovable = new Set<string>();

  // Every weak bullet seen, in the order first seen — see GateOutcome.weakBullets.
  const weakSeen: ScoreBreakdown['weakBullets'] = [];
  const weakTexts = new Set<string>();

  // Consecutive iterations whose score did not move meaningfully.
  let stagnant = 0;
  let previousOverall: number | null = null;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let breakdown: ScoreBreakdown;
    try {
      breakdown = await scoreDocument(current, records, budget, [...unimprovable]);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return haltForBudget(best, current, history, weakSeen, err.message);
      }
      throw err;
    }

    for (const w of breakdown.weakBullets) {
      if (weakTexts.has(w.text.trim())) continue;
      weakTexts.add(w.text.trim());
      weakSeen.push(w);
    }

    breakdown.result.iterations = iteration;
    history.push({
      iteration,
      overall: breakdown.result.overall,
      keywordGatePassed: breakdown.result.keywordGatePassed,
    });
    onIteration?.(iteration, breakdown.result);

    // Keep the best-scoring version seen, not merely the last one (REQ-5.5).
    if (!best || breakdown.result.overall > best.breakdown.result.overall) {
      best = { doc: current, breakdown };
    }

    if (breakdown.result.passed) {
      return {
        document: current,
        result: breakdown.result,
        genuineGaps: breakdown.genuineGaps,
        weakBullets: weakSeen,
        history,
      };
    }

    if (iteration === MAX_ITERATIONS) break;

    // Two revisions in a row that failed to move the score are two revisions that were
    // not revisions. The gain is measured against the previous iteration rather than
    // against the best seen, because a score that dips and recovers is still movement —
    // it is the flat line that says the loop has nothing left to try.
    if (previousOverall !== null) {
      const gain = breakdown.result.overall - previousOverall;
      stagnant = gain >= MIN_MEANINGFUL_GAIN ? 0 : stagnant + 1;
    }
    previousOverall = breakdown.result.overall;

    if (stagnant >= MAX_STAGNANT_ITERATIONS) {
      return haltForNoProgress(
        best!,
        history,
        weakSeen,
        `the last ${MAX_STAGNANT_ITERATIONS} revision passes moved the score by less than ${MIN_MEANINGFUL_GAIN}`,
      );
    }

    // Stop while we still have time to render and return something. A function killed
    // mid-iteration produces nothing at all; stopping one iteration early produces the
    // best resume we managed, plus an honest note about why it stopped there.
    if (budget && !budget.hasTimeForAnotherIteration()) {
      const chosen = best!;
      chosen.breakdown.result.haltReason = 'budget-cap';
      chosen.breakdown.result.haltExplanation = `Stopped after ${iteration} attempt(s) at ${chosen.breakdown.result.overall.toFixed(
        1,
      )}/10 — another revision pass wouldn't have finished inside this deployment's time limit. This is the best version produced so far.`;
      return {
        document: chosen.doc,
        result: chosen.breakdown.result,
        genuineGaps: chosen.breakdown.genuineGaps,
        weakBullets: weakSeen,
        history,
      };
    }

    let revision: ReviseOutcome;
    try {
      revision = await revise(current, breakdown.result.critiques, budget);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return haltForBudget(best, current, history, weakSeen, err.message);
      }
      throw err;
    }

    for (const text of revision.unimprovable) unimprovable.add(text);

    // A revision that changed nothing cannot produce a different score, so scoring it
    // again buys a model call and a wait in exchange for the number we already have.
    if (!revision.changed) {
      return haltForNoProgress(
        best!,
        history,
        weakSeen,
        'the revision pass produced a document identical to the one it was given',
      );
    }

    current = revision.document;
  }

  // Exhausted the cap. Report honestly rather than shipping a forced pass.
  const chosen = best!;
  const gaps = chosen.breakdown.genuineGaps;
  chosen.breakdown.result.haltReason = gaps.length > 0 ? 'unfixable-gap' : 'iteration-cap';
  chosen.breakdown.result.haltExplanation =
    gaps.length > 0
      ? `Stopped at ${chosen.breakdown.result.overall.toFixed(
          1,
        )}/10 after ${MAX_ITERATIONS} attempts. The job asks for ${gaps.join(
          ', ',
        )}, which isn't in your profile. No rewrite can close that honestly — this is the ceiling for this role unless you add real experience covering it.`
      : `Stopped at ${chosen.breakdown.result.overall.toFixed(
          1,
        )}/10 after ${MAX_ITERATIONS} attempts. Showing the best version produced; remaining issues are listed below.`;

  return {
    document: chosen.doc,
    result: chosen.breakdown.result,
    genuineGaps: gaps,
    weakBullets: weakSeen,
    history,
  };
}

/**
 * Stopping because another iteration cannot change anything.
 *
 * The `unfixable-gap` / `iteration-cap` distinction below is preserved rather than
 * replaced: when the profile genuinely lacks what the posting asks for, that is still the
 * useful thing to tell someone, and it is true whether the loop discovered it on
 * iteration 2 or iteration 4. `no-progress` is for the other case — the score stalled for
 * reasons the user cannot act on — and it exists so the explanation can say the loop
 * stopped early on purpose rather than implying it ran out of attempts it never took.
 */
function haltForNoProgress(
  best: { doc: ResumeDocument; breakdown: ScoreBreakdown },
  history: GateOutcome['history'],
  weakBullets: ScoreBreakdown['weakBullets'],
  because: string,
): GateOutcome {
  const gaps = best.breakdown.genuineGaps;
  const attempts = history.length;
  const score = best.breakdown.result.overall.toFixed(1);

  best.breakdown.result.haltReason = gaps.length > 0 ? 'unfixable-gap' : 'no-progress';
  best.breakdown.result.haltExplanation =
    gaps.length > 0
      ? `Stopped at ${score}/10 after ${attempts} attempt(s), early: ${because}. The job asks for ${gaps.join(
          ', ',
        )}, which isn't in your profile. No rewrite can close that honestly — this is the ceiling for this role unless you add real experience covering it.`
      : `Stopped at ${score}/10 after ${attempts} attempt(s) because ${because}. Further attempts would have re-run the same work for the same result, so this is the best version produced; remaining issues are listed below.`;

  return {
    document: best.doc,
    result: best.breakdown.result,
    genuineGaps: gaps,
    weakBullets,
    history,
  };
}

function haltForBudget(
  best: { doc: ResumeDocument; breakdown: ScoreBreakdown } | null,
  current: ResumeDocument,
  history: GateOutcome['history'],
  weakBullets: ScoreBreakdown['weakBullets'],
  message: string,
): GateOutcome {
  if (!best) {
    return {
      document: current,
      result: {
        keywordGatePassed: false,
        keywordCoveragePct: 0,
        missingKeywords: [],
        formattingScore: 0,
        evidenceScore: 0,
        skillsCompletenessScore: 0,
        overall: 0,
        passed: false,
        iterations: history.length,
        critiques: [],
        haltReason: 'budget-cap',
        haltExplanation: message,
      },
      genuineGaps: [],
      weakBullets,
      history,
    };
  }
  best.breakdown.result.haltReason = 'budget-cap';
  best.breakdown.result.haltExplanation = `${message} Showing the best version produced so far.`;
  return {
    document: best.doc,
    result: best.breakdown.result,
    genuineGaps: best.breakdown.genuineGaps,
    weakBullets,
    history,
  };
}
