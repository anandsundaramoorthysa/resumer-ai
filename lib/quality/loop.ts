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
import { scoreSkillsCompleteness } from './skills';
import { scoreEvidence } from './evidence';
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
}

/** One scoring pass. No mutation, no revision — just measurement. */
export async function scoreDocument(
  doc: ResumeDocument,
  records: ProfileRecord[],
  budget?: DraftBudget,
): Promise<ScoreBreakdown> {
  const keywords = scoreKeywordCoverage(doc);
  const formatting = scoreFormatting(doc);
  const skills = scoreSkillsCompleteness(doc, records);

  // Only spend a model call once the cheap deterministic checks are in hand.
  const evidence = await scoreEvidence(doc, budget);

  const overall =
    (formatting.score * WEIGHTS.formatting +
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

  for (const v of formatting.violations) {
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
    formattingScore: formatting.score,
    evidenceScore: evidence.score,
    skillsCompletenessScore: skills.score,
    overall: Number(overall.toFixed(2)),
    passed: keywords.passed && overall >= PASS_THRESHOLD,
    iterations: 0,
    critiques,
  };

  return { result, genuineGaps: skills.genuineGaps };
}

export type ReviseFn = (
  doc: ResumeDocument,
  critiques: Critique[],
  budget?: DraftBudget,
) => Promise<ResumeDocument>;

export interface GateOutcome {
  document: ResumeDocument;
  result: QualityGateResult;
  genuineGaps: string[];
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

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let breakdown: ScoreBreakdown;
    try {
      breakdown = await scoreDocument(current, records, budget);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return haltForBudget(best, current, history, err.message);
      }
      throw err;
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
        history,
      };
    }

    if (iteration === MAX_ITERATIONS) break;

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
        history,
      };
    }

    try {
      current = await revise(current, breakdown.result.critiques, budget);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return haltForBudget(best, current, history, err.message);
      }
      throw err;
    }
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
    history,
  };
}

function haltForBudget(
  best: { doc: ResumeDocument; breakdown: ScoreBreakdown } | null,
  current: ResumeDocument,
  history: GateOutcome['history'],
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
      history,
    };
  }
  best.breakdown.result.haltReason = 'budget-cap';
  best.breakdown.result.haltExplanation = `${message} Showing the best version produced so far.`;
  return {
    document: best.doc,
    result: best.breakdown.result,
    genuineGaps: best.breakdown.genuineGaps,
    history,
  };
}
