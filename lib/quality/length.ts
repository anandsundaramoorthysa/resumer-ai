/**
 * Document length — AUDIT #7, scored as part of REQ-5.2's formatting sub-score.
 *
 * Nothing checked this. A resume that is really three pages and one that is really half
 * a page both scored exactly what a well-judged one did, because every formatting rule is
 * about how a line is written and none is about how many there are. The observed case was
 * ~1,150 characters — about 180 words, with no Experience section at all.
 *
 * It lives here and not in `formatting.ts` for a reason that module states about itself:
 * every rule in it "maps to a mechanical parsing failure mode, not to style preference",
 * and a parser reads a 180-word resume perfectly well. Length is a judgement about the
 * document, not about whether it survives extraction, and mixing the two would also mean
 * `scoreFormatting` — which the self-test and the smoke script both call expecting a
 * verdict on parseability — started returning verdicts on substance.
 *
 * It is still priced as one formatting rule (see `combinedFormattingScore`), because that
 * is the weight it deserves: one rule of eleven inside a sub-score weighted 0.30, roughly
 * a quarter of a point out of ten. A nudge for the revision loop, not a veto — length here
 * is a symptom of the data gaps in AUDIT #2 and #5, and no rewrite can honestly close
 * those.
 */

import type { ResumeDocument } from '../types';
import {
  contentLineAllowance,
  contentWordAllowance,
  CONTENT_LINES_PER_PAGE,
  CONTENT_WORDS_PER_PAGE,
} from '../generate/assemble';
import {
  distinctRuleCount,
  FORMATTING_RULE_COUNT,
  type FormattingResult,
  type FormattingViolation,
} from './formatting';

/**
 * How short a resume may be before the length is itself the defect.
 *
 * Not the research target. A resume below the 350-word one-page figure is thinner than
 * ideal, but plenty of genuine early-career resumes sit at 300 and there is nothing in
 * them to fix — firing there would make this noise, and a check that fires on everything
 * is worth as much as one that never fires. The assembler agrees: it prints Interests
 * only on a resume with six spare lines, which is a documented decision that a short
 * resume is a normal output rather than a defect.
 *
 * 60% of a page is where the arithmetic stops being a matter of taste. The fixed costs
 * do not shrink — contact, a summary, a skills line, education and the section headings
 * cost about 90 words whatever else happens — so below 210 words there are under 120 left
 * for Experience and Projects, which is five or six bullets for an entire career. At that
 * point the document is not concise, it is missing content.
 *
 * The two numbers it sits between are what fix it in place: the resume the audit actually
 * observed was ~180 words, and the research target for one page is 350. A floor of 210
 * catches the first and stays well clear of the second.
 *
 * The floor is one page's worth and does not double when the budget does. A second page
 * is permission, not an obligation — a senior engineer with a tight single-page resume has
 * done nothing wrong, and doubling the floor would tell them they had.
 */
const MIN_PAGE_FRACTION = 0.6;

/**
 * Slack on the upper word bound only.
 *
 * The line budget is the real page constraint and is enforced exactly; the word figure
 * derived from it assumes an average line, and a resume of unusually full lines is dense
 * rather than overlong. 15% is roughly the gap between the ~12-word average the budget
 * assumes and the ~15 words a genuinely full line holds.
 */
const LONG_WORD_TOLERANCE = 1.15;

export interface LengthResult {
  words: number;
  lines: number;
  /** Absent when the length is fine, or when there is nothing to judge it against. */
  violation?: FormattingViolation;
}

function contentLines(doc: ResumeDocument): number {
  return doc.sections.reduce((n, s) => {
    const groups = s.groups ?? [];
    return (
      n + s.items.length + groups.length + groups.reduce((m, g) => m + g.items.length, 0)
    );
  }, 0);
}

/**
 * Headings are excluded on purpose: "Professional Experience" is two words of structure,
 * not two words of content, and counting them would let a thin resume pad its way past
 * the floor by printing more sections.
 */
function contentWords(doc: ResumeDocument): number {
  const parts: string[] = [];
  for (const s of doc.sections) {
    for (const i of s.items) parts.push(i.text);
    for (const g of s.groups ?? []) {
      parts.push(g.title, g.subtitle ?? '');
      for (const i of g.items) parts.push(i.text);
    }
  }
  return parts.join(' ').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Both bounds are measured against the SAME page budget assembly spends
 * (`CONTENT_LINES_PER_PAGE` / `CONTENT_WORDS_PER_PAGE`), deliberately. A second,
 * independent notion of how long a page is would drift from the first, and then the
 * assembler and the scorer would disagree about a document neither was wrong about.
 *
 * The scorer cannot know `totalYears` — it sees a document, not a career — so it asks the
 * budget for the one-page case unless the posting's own seniority justifies two. That is
 * the conservative direction: a two-page-worthy resume judged against one page can be
 * told it is long, never that it is short.
 */
export function scoreLength(doc: ResumeDocument): LengthResult {
  const job = doc.jobRequirement;
  const lines = contentLines(doc);
  const words = contentWords(doc);

  // No posting, no budget. Seniority is what buys a second page, so with no job attached
  // the check would be measuring against an assumption. That document is the baseline
  // resume (REQ-6.7), which exists to show the profile as it stands; its length is a fact
  // about the profile, and a thin profile is reported by the gaps UI. The keyword gate
  // declines to judge the baseline for the same reason.
  if (!job) return { words, lines };

  // Emptiness is already reported by formatting's `has-substance`. Saying it twice would
  // cost one problem two rules.
  if (lines === 0) return { words, lines };

  const lineBudget = contentLineAllowance(job, 0);
  const wordBudget = contentWordAllowance(job, 0);

  if (lines > lineBudget || words > wordBudget * LONG_WORD_TOLERANCE) {
    return {
      words,
      lines,
      violation: {
        rule: 'plausible-length',
        detail: `${words} words across ${lines} content lines overruns the ${
          lineBudget > CONTENT_LINES_PER_PAGE ? 'two-page' : 'one-page'
        } budget of ${lineBudget} lines. A resume that spills onto a page nobody reads to the bottom of loses the material on that page.`,
      },
    };
  }

  const floor = Math.round(CONTENT_WORDS_PER_PAGE * MIN_PAGE_FRACTION);
  if (words < floor) {
    return {
      words,
      lines,
      violation: {
        rule: 'plausible-length',
        detail: `${words} words is under ${floor} — less than ${Math.round(
          MIN_PAGE_FRACTION * 100,
        )}% of a page. Once the fixed sections are paid for, that leaves too little Experience and Projects for a reader to judge anything by.`,
      },
    };
  }

  return { words, lines };
}

/**
 * The formatting sub-score the quality gate actually uses: the parseability rules plus
 * length, each rule priced identically. Adding length as an nth rule rather than as a
 * multiplier is what keeps "the resume is too short" from costing more or less than "the
 * heading is not on the allow-list", which nobody could defend either way.
 */
export function combinedFormattingScore(
  formatting: FormattingResult,
  length: LengthResult,
): number {
  const total = FORMATTING_RULE_COUNT + 1;
  const broken = distinctRuleCount(formatting.violations) + (length.violation ? 1 : 0);
  return Math.max(0, (total - broken) / total);
}
