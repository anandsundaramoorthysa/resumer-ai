/**
 * Composing and grading a hand-written experience bullet.
 *
 * Pure and dependency-free on purpose: the same functions run in the browser to give
 * live feedback while the user types, on the server to build the stored `text`, and in
 * tests. A second implementation for the client would drift from the one that writes
 * the record.
 *
 * The three fields exist because `lib/quality/evidence.ts` grades on action + scale +
 * outcome. Asked for one free-text bullet, people write the action and stop, which is
 * exactly the shape that scores 0 — the live profile had six bullets and an evidence
 * sub-score of 0%. Three labelled boxes make the missing two thirds visible before the
 * record is saved rather than after a resume is generated from it.
 */

import { extractNumbers } from '../generate/grounding';

/** Research puts the readable ceiling for a resume line at roughly two printed lines. */
export const MAX_BULLET_WORDS = 30;

export interface BulletParts {
  action: string;
  scale?: string;
  outcome?: string;
}

/** The worked example shown beside the form, kept here so UI and tests agree on it. */
export const BULLET_EXAMPLE: Required<BulletParts> = {
  action: 'Optimized PostgreSQL queries',
  scale: 'serving 200K daily requests',
  outcome: 'cutting p95 latency 40%',
};

function tidy(value: string | undefined): string {
  return (value ?? '').trim().replace(/^[\s,;.]+/, '').replace(/[\s,;.]+$/, '');
}

/**
 * Joins the three parts into the stored `text`.
 *
 * No connecting words are inserted between action and scale. "Optimized queries" +
 * "200K requests" would need a "serving" or an "across" to read as English, and this
 * module is not allowed to pick one: an invented word is an invented claim, which is the
 * one thing the whole product promises not to do (NFR-8). The scale field's placeholder
 * asks for the connective instead, so the phrase the user typed is the phrase that ships.
 */
export function composeBulletText(parts: BulletParts): string {
  const action = tidy(parts.action);
  if (!action) return '';
  const scale = tidy(parts.scale);
  const outcome = tidy(parts.outcome);

  let text = action;
  if (scale) text += ` ${scale}`;
  if (outcome) text += `, ${outcome}`;
  return endsNeedingPeriod(text) ? `${text}.` : text;
}

/**
 * A Latin full stop belongs after Latin text only. Hindi ends in a danda (।), Tamil and the
 * other scripts have their own conventions, and a '.' glued onto them is wrong; the user's
 * own ending (or none) is kept. Digits, closing brackets and '%' still get the period.
 */
function endsNeedingPeriod(text: string): boolean {
  const last = [...text].pop() ?? '';
  if (/[।॥!?]/.test(last)) return false;
  if (/[\p{M}]/u.test(last)) return false;
  if (/\p{L}/u.test(last)) return /\p{Script=Latin}/u.test(last);
  return true;
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Whether the bullet states a figure. Deliberately the same notion of "number" the
 * anti-fabrication guard uses, so a bullet that reads as quantified here is quantified
 * by the same rule that later has to find those digits in the source.
 */
export function hasMetric(text: string): boolean {
  return extractNumbers(text).length > 0;
}

export interface BulletCheck {
  id: 'metric' | 'scale' | 'outcome' | 'length';
  label: string;
  ok: boolean;
  /** Shown only while the check is failing. */
  hint: string;
}

export interface BulletAssessment {
  text: string;
  words: number;
  checks: BulletCheck[];
  /** True when every check passes — advisory, never a gate on saving. */
  strong: boolean;
}

/**
 * Advisory only. A bullet that fails every check still saves: some real work genuinely
 * has no number attached, and refusing to store it would push the user toward inventing
 * one, which is worse than a weak bullet.
 */
export function assessBullet(parts: BulletParts): BulletAssessment {
  const text = composeBulletText(parts);
  const words = wordCount(text);

  const checks: BulletCheck[] = [
    {
      id: 'metric',
      label: 'States a number',
      ok: hasMetric(text),
      hint: 'A figure you can stand behind — 40%, 200K, 12 weeks, 4 clients.',
    },
    {
      id: 'scale',
      label: 'Says at what scale',
      ok: tidy(parts.scale).length > 0,
      hint: 'How big, how many, or for whom — the grader treats this as its own signal.',
    },
    {
      id: 'outcome',
      label: 'Says what changed',
      ok: tidy(parts.outcome).length > 0,
      hint: 'The result, not the task. What was different afterwards?',
    },
    {
      id: 'length',
      label: `Under ${MAX_BULLET_WORDS} words`,
      ok: words > 0 && words <= MAX_BULLET_WORDS,
      hint:
        words > MAX_BULLET_WORDS
          ? `${words} words — trim it, a bullet that wraps past two lines gets skimmed.`
          : 'Write the action first.',
    },
  ];

  return { text, words, checks, strong: checks.every((c) => c.ok) };
}
