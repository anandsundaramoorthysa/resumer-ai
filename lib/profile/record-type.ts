/**
 * What kind of profile record a newly-extracted fact actually is.
 *
 * Every path that turns a sentence into a record used to let a prompt decide the type:
 * `extractClaims` in ./claim.ts asks a model to pick from twelve, and the enrichment
 * queue's skill branch (lib/server/enrichment.ts) did not ask at all — it called
 * `createSkill` for whatever keyword the posting had named. Both mis-file, and a
 * mis-filed record is worse than a missing one, because it prints. Measured on the real
 * classifier before this existed:
 *
 *   classifySkill('AWS Certified Solutions Architect') → null
 *   classifySkill('Certified Scrum Master')            → null
 *   classifySkill('Six Sigma Black Belt')              → null
 *
 * and `suggestedSkillCategory(topic) ?? 'tool'` turned each of them into a skill of
 * category `tool`, which `SKILL_CATEGORY_LABELS` prints under "tools" on the resume. A
 * certification listed as a tool is a smaller claim than the truth AND in the wrong
 * section, and the Skills section is the heaviest thing the scorer reads.
 *
 * So the type decision is made here, deterministically, the way lib/skills/categories.ts
 * makes the category decision: named cues first, the skill dictionary next, and no answer
 * at all when neither is sure. Null is the valuable outcome — a record the rules cannot
 * place is handed back to the user to confirm rather than guessed into a section.
 *
 * Pure and model-free on purpose. A prompt's opinion about a type is unreviewable and
 * different on every run; these rules can be read, tested and argued with.
 *
 * MERGE NOTE for Engineer A: the award-vs-achievement line is drawn in one place here
 * (`AWARD_CUE` plus the downgrade in `fileRecord`). When your helper in
 * ./forms.ts lands, delete the cue and call it instead — nothing else in this file cares
 * which of the two it is.
 */

import { classifySkill } from '../skills/categories';

/** The types these rules can positively name. Everything else stays the caller's. */
export type SettledRecordType =
  | 'certification'
  | 'publication'
  | 'award'
  | 'achievement'
  | 'education'
  | 'skill';

/**
 * Types that assert a third party gave the person something.
 *
 * A wrong guess on any of these is a claim about an institution, not just a filing
 * mistake: "Google Analytics Certified" invented from "I do analytics" is a lie with
 * Google's name on it. So when the rules cannot settle one of these, the caller must ask
 * rather than keep it — see `fileRecord`.
 */
export const CREDENTIAL_TYPES = new Set([
  'certification',
  'education',
  'publication',
  'award',
]);

/**
 * Something was awarded to them by a body that examines or accredits.
 *
 * Deliberately does NOT include a bare "certificate": "Certificate Management" is a real
 * skill (PKI work) and the earlier draft of this rule filed it as a certification. The
 * cue is the act of being certified, not the noun.
 */
const CERTIFICATION_CUE =
  /\b(certified|certification|certificate (?:in|of|from)|credentialed|licen[sc]ed?|nanodegree|specializations?|accredited|chartered|pmp|cissp|ceh|ccna|ccnp|aws saa|scrum master|product owner|(?:black|green|yellow) belt)\b/i;

/** It was published somewhere that publishes. */
const PUBLICATION_CUE =
  /\b(paper|journal|proceedings|preprint|ieee|acm|springer|elsevier|arxiv|doi|isbn|pubmed|peer[- ]reviewed)\b/i;

/**
 * A competition or a body picked them out.
 *
 * "won" and "winner" are here and "completed" is not: finishing something is an
 * achievement, being chosen over other people is an award. That is the whole distinction,
 * and it is the one Engineer A is formalising.
 */
const AWARD_CUE =
  /\b(awards?|awarded|prize|medal|medall?ist|trophy|scholarship|fellowship|dean'?s list|winner|won|runner[- ]up|(?:first|second|third|1st|2nd|3rd) place|finalist|honou?rable mention|topper|rank holder)\b/i;

/** A qualification from a place that teaches. */
const EDUCATION_CUE =
  /\b(b\.?\s?sc|m\.?\s?sc|b\.?\s?tech|m\.?\s?tech|b\.?\s?e|m\.?\s?e|b\.?\s?a|m\.?\s?a|bachelor'?s?|master'?s?|ph\.?\s?d|doctorate|mba|bca|mca|bba|diploma|degree|sslc|hsc|intermediate)\b/i;

export interface RecordTypeVerdict {
  /** The type the rules name, or null when none of them is sure. */
  type: SettledRecordType | null;
  /** Which rule fired — for the message shown when a record is re-filed or queried. */
  why: string;
}

const field = (data: Record<string, unknown>, key: string): string =>
  typeof data[key] === 'string' ? (data[key] as string).trim() : '';

/**
 * The text that says what the record IS, rather than anything about it.
 *
 * Names and titles only. A description is where someone writes "this won me a place on
 * the team", and matching cues against that filed half the projects in a test profile as
 * awards.
 */
function subjectText(data: Record<string, unknown>): string {
  return [field(data, 'name'), field(data, 'title'), field(data, 'credential')]
    .filter(Boolean)
    .join(' ');
}

/**
 * The type this fact is, by the rules, or null when they cannot tell.
 *
 * Order is cheapest-and-most-specific first and each rule is a phrase somebody actually
 * wrote, so the first match wins and nothing is scored against anything else. A structural
 * field — `issuer`, `institution`, `venue` — counts as its own evidence: a model that
 * filled in `venue` was reading a publication whatever it then called the record.
 */
export function classifyRecordType(data: Record<string, unknown>): RecordTypeVerdict {
  const subject = subjectText(data);
  if (!subject) return { type: null, why: 'nothing names it' };

  if (CERTIFICATION_CUE.test(subject)) {
    return { type: 'certification', why: 'it says it was certified or credentialed' };
  }
  if (field(data, 'venue') || PUBLICATION_CUE.test(subject)) {
    return { type: 'publication', why: 'it names where it was published' };
  }
  if (AWARD_CUE.test(subject)) {
    return { type: 'award', why: 'it says it was won or awarded' };
  }
  if (field(data, 'institution') && EDUCATION_CUE.test(subject)) {
    return { type: 'education', why: 'it is a qualification from an institution' };
  }

  // A name the skill classifier recognises — by dictionary or by shape — is a skill. Run
  // last so "AWS Certified Solutions Architect" is a certification even on the day the
  // dictionary learns "AWS".
  if (classifySkill(subject)) {
    return { type: 'skill', why: 'it is a named skill' };
  }

  return { type: null, why: 'nothing here says what kind of thing it is' };
}

/**
 * Where this record should be filed, for the one caller that has to decide.
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   moved     a rule named a different type. Store it there.
 *   kept      the rules agree with, or have nothing to say about, a type that asserts
 *             nothing about a third party. Store it as proposed.
 *   confirm   no rule supports it and the proposed type asserts that somebody ELSE gave
 *             them something — a certificate, a degree, a place in a journal. Do not
 *             store it: hand the sentence back and let them say which it is. A model
 *             proposing `achievement` or `skill` unaided is filing a claim the person
 *             made about themselves, which ./claim.ts already holds to their own words;
 *             a model proposing `certification` from nothing certificate-shaped has
 *             decided something about an institution.
 *
 * `award` never reaches `confirm`, because it has a safe downgrade: when nothing says a
 * thing was won, it is a thing they did. A claim about a jury is never inferred, and the
 * reverse direction — achievement promoted to award — is not available on purpose.
 */
export interface RecordFiling {
  type: string;
  why: string;
  moved: boolean;
  confirm: boolean;
}

export function fileRecord(proposed: string, data: Record<string, unknown>): RecordFiling {
  const verdict = classifyRecordType(data);

  if (verdict.type && verdict.type !== proposed) {
    return { type: verdict.type, why: verdict.why, moved: true, confirm: false };
  }
  if (!verdict.type && proposed === 'award') {
    return {
      type: 'achievement',
      why: 'nothing says it was won, so it is a thing you did',
      moved: true,
      confirm: false,
    };
  }
  if (!verdict.type && CREDENTIAL_TYPES.has(proposed)) {
    return { type: proposed, why: verdict.why, moved: false, confirm: true };
  }
  return { type: proposed, why: verdict.why, moved: false, confirm: false };
}
