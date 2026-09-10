/**
 * The quality gate — REQ-5.1 through REQ-5.6.
 *
 *   keyword gate (70%, pass/fail)
 *     -> weighted score: formatting 0.30 + evidence 0.30 + skills 0.40
 *     -> >= 8.5  : done
 *     -> <  8.5  : critique -> targeted revise -> re-score, up to MAX_ITERATIONS passes
 *                  per request and MAX_TOTAL_ITERATIONS across every request for one resume
 *     -> exhausted: HONEST FAILURE — best version + why, never a forced pass
 *
 * The invariant that matters most: when the score cannot be reached with real data, the
 * loop stops and says so. It never relaxes the no-fabrication rule to clear the bar
 * (NFR-8). A wording problem gets fixed here; a real experience gap gets reported.
 *
 * Resumable, because of where it runs. On Netlify's free tier a function is killed at 30
 * seconds, and a draft that reads the job, assembles, scores and renders has room for one
 * revision pass inside that — every production draft stopped there, marked `budget-cap`,
 * with three of its four passes never taken. Rather than ask the platform for more time,
 * the loop writes down where it got to (`LoopState`, on `result.loop`) and a later request
 * hands that back as `resume`. Each request stays short; the loop still gets its passes.
 */

import type {
  Critique,
  LoopState,
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
import { AllProvidersFailedError } from '../ai/chain';
import { isRoleTitleTerm } from '../fit/assess';

export const PASS_THRESHOLD = 8.5;

/** Scoring passes one request may run. */
export const MAX_ITERATIONS = 4;

/**
 * Scoring passes one resume may have in total, across every request that resumes it.
 *
 * Twice the per-request allowance. The loop's own no-progress rule is what normally ends
 * it — two passes that fail to move the score — so this is a ceiling on cost for the rare
 * resume that keeps inching upward, not a target.
 */
export const MAX_TOTAL_ITERATIONS = 8;

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
  //
  // And if that call cannot finish, keep them. Keywords, formatting, length and skills
  // are all decided above without a model; evidence is the one sub-score that needs one.
  // When the evidence call ran out of time, this function used to throw — discarding
  // grading it had already done — and the loop's first-iteration fallback then reported
  // the finished resume as 0/10, a number that went on to the dashboard average. So the
  // deterministic grades stand, and evidence is counted as zero with the reason attached:
  // a floor that never invents a grade, rather than a zero that erases real ones.
  let evidence: Awaited<ReturnType<typeof scoreEvidence>>;
  let evidenceUngraded: string | null = null;
  try {
    evidence = await scoreEvidence(doc, budget, alreadyTried);
  } catch (err) {
    evidenceUngraded = outOfTime(err);
    if (!evidenceUngraded) throw err;
    evidence = { score: 0, weakBullets: [], provider: 'n/a' };
  }

  const overall =
    (formattingScore * WEIGHTS.formatting +
      evidence.score * WEIGHTS.evidence +
      skills.score * WEIGHTS.skills) *
    10;

  const critiques: Critique[] = [];

  if (evidenceUngraded) {
    critiques.push({
      subScore: 'evidence',
      message: `Evidence was not graded: ${evidenceUngraded} It is counted as zero rather than guessed, so the overall score here is a floor, not a verdict.`,
    });
  }

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
  // `reviseDocument` repairs these rules mechanically, without a model: icon glyphs,
  // decorative bullet characters, tabs, numeric dates, and — since the page trim in
  // generate/fit-page.ts — a resume that runs past its page. The rest — a resume too
  // SHORT, the heading allow-list, a missing Skills section, a document with no
  // substance, the contact block, hyperlink text, presentation mode — are decided during
  // assembly or by the profile behind it, and no rewrite of the finished document can
  // close them.
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

  // The posting's own title is not a gap in anyone's experience. Keyword extraction lists
  // it (ATS filters do match titles), so the skills scorer counted it as something the
  // profile lacks, and the halt text told the EA candidate "the job asks for Product
  // Analyst Intern … which isn't in your profile". The fit check already excludes title
  // terms by the same rule; this is where the halt text gets its list.
  const roleTitle = doc.jobRequirement?.roleTitle ?? '';
  const genuineGaps = skills.genuineGaps.filter((g) => !isRoleTitleTerm(g, roleTitle));

  return { result, genuineGaps, weakBullets: evidence.weakBullets };
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
  /** Always carries `loop` — what a later request resumes from. */
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

type Best = { doc: ResumeDocument; breakdown: ScoreBreakdown };

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
  /**
   * Carry on from a result an earlier request saved, instead of starting over.
   *
   * `document` must be the version that result scored. The saved result is not scored
   * again — its critiques are exactly what that request ran out of time to act on, so the
   * first step here is the revision it never made, which saves a judge call as well as
   * the time.
   */
  resume?: QualityGateResult;
}): Promise<GateOutcome> {
  const { records, revise, budget, onIteration, resume } = args;
  const saved = resume?.loop;

  let current = args.document;
  let best: Best | null = resume
    ? {
        doc: args.document,
        breakdown: { result: resume, genuineGaps: saved?.genuineGaps ?? [], weakBullets: [] },
      }
    : null;
  const history: GateOutcome['history'] = saved ? [...saved.history] : [];

  // Bullets a revision pass has already proved it cannot strengthen. Carried forward so
  // the evidence scorer stops charging for the same verdict every iteration — and, now,
  // every request.
  const unimprovable = new Set<string>(saved?.unimprovable ?? []);

  // Every weak bullet seen, in the order first seen — see GateOutcome.weakBullets.
  const weakSeen: ScoreBreakdown['weakBullets'] = [];
  const weakTexts = new Set<string>();

  // Consecutive iterations whose score did not move meaningfully.
  let stagnant = saved?.stagnant ?? 0;
  let previousOverall: number | null = saved?.previousOverall ?? null;

  let iteration = saved?.iterations ?? 0;
  const lastThisRequest = Math.min(MAX_TOTAL_ITERATIONS, iteration + MAX_ITERATIONS);

  /** Every way out goes through here, so every result says where the loop got to. */
  const seal = (outcome: GateOutcome, canContinue: boolean): GateOutcome => {
    const state: LoopState = {
      iterations: iteration,
      history: [...history],
      unimprovable: [...unimprovable],
      stagnant,
      previousOverall,
      genuineGaps: outcome.genuineGaps,
      canContinue: canContinue && !outcome.result.passed && iteration < MAX_TOTAL_ITERATIONS,
    };
    outcome.result.loop = state;
    return outcome;
  };

  // A resumed run already holds a scored breakdown; a fresh one scores first.
  let pending: ScoreBreakdown | null = best ? best.breakdown : null;

  for (;;) {
    let breakdown: ScoreBreakdown;

    if (pending) {
      breakdown = pending;
      pending = null;
      if (breakdown.result.passed) {
        return seal(
          {
            document: current,
            result: breakdown.result,
            genuineGaps: breakdown.genuineGaps,
            weakBullets: weakSeen,
            history,
          },
          false,
        );
      }
    } else {
      iteration += 1;
      try {
        breakdown = await scoreDocument(current, records, budget, [...unimprovable]);
      } catch (err) {
        const halt = outOfTime(err);
        if (halt) return seal(haltForBudget(best, current, history, weakSeen, halt), true);
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

      // Keep the best-scoring version seen, not merely the last one (REQ-5.5) — and on a
      // resumed run that includes the version the earlier request saved, so a pass that
      // makes things worse can never replace it.
      if (!best || breakdown.result.overall > best.breakdown.result.overall) {
        best = { doc: current, breakdown };
      }

      if (breakdown.result.passed) {
        return seal(
          {
            document: current,
            result: breakdown.result,
            genuineGaps: breakdown.genuineGaps,
            weakBullets: weakSeen,
            history,
          },
          false,
        );
      }

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
        return seal(
          haltForNoProgress(
            best,
            history,
            weakSeen,
            `the last ${MAX_STAGNANT_ITERATIONS} revision passes moved the score by less than ${MIN_MEANINGFUL_GAIN}`,
          ),
          false,
        );
      }
    }

    // Exhausted, for good: no request after this one would be allowed another pass.
    if (iteration >= MAX_TOTAL_ITERATIONS) {
      return seal(haltForCap(best!, history, weakSeen, iteration), false);
    }

    // Stop while there is still time to render and return something — and say that this
    // is a pause, not an ending. A function killed mid-iteration produces nothing at all;
    // stopping one iteration early produces the best resume so far, which a later request
    // can pick up from exactly here.
    if (iteration >= lastThisRequest || (budget && !budget.hasTimeForAnotherIteration())) {
      return seal(pause(best!, history, weakSeen, iteration), true);
    }

    let revision: ReviseOutcome;
    try {
      revision = await revise(current, breakdown.result.critiques, budget);
    } catch (err) {
      const halt = outOfTime(err);
      if (halt) return seal(haltForBudget(best, current, history, weakSeen, halt), true);
      throw err;
    }

    for (const text of revision.unimprovable) unimprovable.add(text);

    // A revision that changed nothing cannot produce a different score, so scoring it
    // again buys a model call and a wait in exchange for the number we already have.
    if (!revision.changed) {
      return seal(
        haltForNoProgress(
          best!,
          history,
          weakSeen,
          'the revision pass produced a document identical to the one it was given',
        ),
        false,
      );
    }

    current = revision.document;
  }
}

/**
 * How many gaps a halt sentence names before it counts the rest.
 *
 * The EA job description produced 27, and the halt text listed every one — a sentence
 * nobody reads to the end is not an explanation. The full list is still on the fit card,
 * split into what the profile holds and what it does not.
 */
const MAX_GAPS_NAMED = 8;

function listGaps(gaps: string[]): string {
  const named = gaps.slice(0, MAX_GAPS_NAMED);
  const rest = gaps.length - named.length;
  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

function outcomeOf(
  best: Best,
  history: GateOutcome['history'],
  weakBullets: ScoreBreakdown['weakBullets'],
): GateOutcome {
  return {
    document: best.doc,
    result: best.breakdown.result,
    genuineGaps: best.breakdown.genuineGaps,
    weakBullets,
    history,
  };
}

/** Stopped for this request, with more passes available to a later one. */
function pause(
  best: Best,
  history: GateOutcome['history'],
  weakBullets: ScoreBreakdown['weakBullets'],
  attempts: number,
): GateOutcome {
  const result = best.breakdown.result;
  result.haltReason = 'budget-cap';
  result.haltExplanation = `Paused at ${result.overall.toFixed(
    1,
  )}/10 after ${attempts} attempt(s) to stay inside the server's time limit. This is the best version so far, and improving can pick up from exactly here.`;
  return outcomeOf(best, history, weakBullets);
}

/** Every pass this resume will ever get has been used. Report honestly. */
function haltForCap(
  best: Best,
  history: GateOutcome['history'],
  weakBullets: ScoreBreakdown['weakBullets'],
  attempts: number,
): GateOutcome {
  const result = best.breakdown.result;
  const gaps = best.breakdown.genuineGaps;
  result.haltReason = gaps.length > 0 ? 'unfixable-gap' : 'iteration-cap';
  result.haltExplanation =
    gaps.length > 0
      ? `Stopped at ${result.overall.toFixed(1)}/10 after ${attempts} attempts. The job asks for ${listGaps(gaps)}, which isn't in your profile. No rewrite can close that honestly — this is the ceiling for this role unless you add real experience covering it.`
      : `Stopped at ${result.overall.toFixed(1)}/10 after ${attempts} attempts. Showing the best version produced; remaining issues are listed below.`;
  return outcomeOf(best, history, weakBullets);
}

/**
 * Stopping because another iteration cannot change anything.
 *
 * The `unfixable-gap` / `iteration-cap` distinction is preserved rather than replaced:
 * when the profile genuinely lacks what the posting asks for, that is still the useful
 * thing to tell someone, and it is true whether the loop discovered it on iteration 2 or
 * iteration 4. `no-progress` is for the other case — the score stalled for reasons the
 * user cannot act on — and it exists so the explanation can say the loop stopped early on
 * purpose rather than implying it ran out of attempts it never took.
 */
function haltForNoProgress(
  best: Best,
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
      ? `Stopped at ${score}/10 after ${attempts} attempt(s), early: ${because}. The job asks for ${listGaps(gaps)}, which isn't in your profile. No rewrite can close that honestly — this is the ceiling for this role unless you add real experience covering it.`
      : `Stopped at ${score}/10 after ${attempts} attempt(s) because ${because}. Further attempts would have re-run the same work for the same result, so this is the best version produced; remaining issues are listed below.`;

  return outcomeOf(best, history, weakBullets);
}

/**
 * A call that could not finish in time, however the chain chose to report it.
 *
 * This loop was built to stop early and keep its best version when time runs out, and it
 * only ever recognised `BudgetExceededError`. But that is thrown BETWEEN calls. When the
 * clock runs out DURING one, the chain exhausts its attempt windows and throws
 * `AllProvidersFailedError` instead — which this loop rethrew, and which took down a
 * resume that had already been fully assembled. In production, on a 30-second function,
 * that was the common case rather than the edge one: a late scoring call got the last
 * second and a half of the budget, one provider timed out inside it, and the draft
 * failed with a finished document in hand.
 *
 * Either way the right outcome is the same — keep the resume, say why it stopped. The
 * chain's own message is not passed through: it names providers and their raw errors,
 * which were written for a developer, and haltForBudget shows its message to the user.
 */
function outOfTime(err: unknown): string | null {
  // Matched by name as well as by class, because `instanceof` is only reliable when both
  // sides share one copy of the module, and that is not guaranteed. Under tsx — which the
  // test suite runs on — this file is transpiled to CommonJS and `require`s the error
  // classes, while an ES-module caller imports the same files through the ESM loader: the
  // file is loaded twice, the two classes are distinct, and `instanceof` quietly returns
  // false. The tests for this function failed exactly that way while the code under them
  // was correct. Both classes assign `name` as a string literal rather than inheriting it
  // from the class, so the check also survives minification in a production bundle.
  const name = err instanceof Error ? err.name : '';
  if (err instanceof BudgetExceededError || name === 'BudgetExceededError') {
    return (err as Error).message;
  }
  if (err instanceof AllProvidersFailedError || name === 'AllProvidersFailedError') {
    return 'The AI providers could not finish grading this draft — they were unavailable or ran out of time.';
  }
  return null;
}

function haltForBudget(
  best: Best | null,
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
  return outcomeOf(best, history, weakBullets);
}
