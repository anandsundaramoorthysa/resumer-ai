/**
 * Carrying a fit assessment from one request to the next — without storing it.
 *
 * The draft is now two requests: one reads the job and judges the fit, and a second one,
 * started only if the fit is good or the user says "draft it anyway", writes the resume.
 * The split is what keeps each inside Netlify's 30-second limit. But the second request
 * needs what the first one learned — the extracted job and the verdict — and there were
 * two ways to hand that across.
 *
 * A table would work, and would leave a row behind for every job anyone ever checked,
 * including the ones they decided not to apply for. The job text itself cannot be part of
 * it at all: the upload control promises an attached description is "read in memory and
 * never stored". So the assessment travels with the browser instead, sealed with the same
 * AES-256-GCM box that protects the GitHub tokens (lib/auth/secret-box.ts). The browser
 * holds it and cannot read or alter it; a declined fit check leaves nothing anywhere.
 *
 * Bound to the account and to an hour. A token lifted from one session is useless in
 * another, and a stale one cannot resurrect a verdict about a profile that has since
 * changed.
 */

import { decryptSecret, encryptSecret, looksEncrypted } from '../auth/secret-box';
import type { JobRequirement } from '../types';
import type { FitReport } from './agent';

/** Long enough to read a verdict and decide; short enough that it cannot go stale. */
export const ASSESSMENT_TTL_MS = 60 * 60 * 1000;

/** A job and a report are a few KB. Anything near this is not a token we wrote. */
const MAX_TOKEN_CHARS = 96_000;

/** Tolerated disagreement between two function instances' clocks. */
const CLOCK_SKEW_MS = 60_000;

interface Envelope {
  v: 1;
  userId: string;
  issuedAt: number;
  job: JobRequirement;
  fit: FitReport;
}

/** Every refusal says what to do next, because it is shown to the person who hit it. */
export class AssessmentTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentTokenError';
  }
}

export function sealAssessment(
  userId: string,
  job: JobRequirement,
  fit: FitReport,
  now = Date.now(),
): string {
  const envelope: Envelope = { v: 1, userId, issuedAt: now, job, fit };
  return encryptSecret(JSON.stringify(envelope));
}

export function openAssessment(
  token: unknown,
  userId: string,
  now = Date.now(),
): { job: JobRequirement; fit: FitReport } {
  const rerun = 'Run the fit check again to draft this resume.';

  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
    throw new AssessmentTokenError(`The fit check was missing or unreadable. ${rerun}`);
  }

  // Refused BEFORE decrypting, and this is the line that makes the seal a seal.
  // `decryptSecret` returns anything that is not in its encrypted shape unchanged — it was
  // written for a column that held plaintext GitHub tokens before encryption existed. Used
  // here without this check, a browser could send a hand-written JSON "assessment" and it
  // would come back out as if it had been sealed.
  if (!looksEncrypted(token)) {
    throw new AssessmentTokenError(`The fit check was not issued by this server. ${rerun}`);
  }

  let plain: string;
  try {
    plain = decryptSecret(token);
  } catch {
    // GCM refuses an altered ciphertext outright, which is the point of using it.
    throw new AssessmentTokenError(`The fit check could not be verified. ${rerun}`);
  }

  let envelope: Partial<Envelope>;
  try {
    envelope = JSON.parse(plain) as Partial<Envelope>;
  } catch {
    throw new AssessmentTokenError(`The fit check could not be verified. ${rerun}`);
  }

  if (
    envelope.v !== 1 ||
    typeof envelope.userId !== 'string' ||
    typeof envelope.issuedAt !== 'number' ||
    !envelope.job ||
    !envelope.fit
  ) {
    throw new AssessmentTokenError(`The fit check could not be verified. ${rerun}`);
  }

  if (envelope.userId !== userId) {
    throw new AssessmentTokenError(`That fit check belongs to a different account. ${rerun}`);
  }

  if (envelope.issuedAt > now + CLOCK_SKEW_MS || now - envelope.issuedAt > ASSESSMENT_TTL_MS) {
    throw new AssessmentTokenError(`That fit check has expired. ${rerun}`);
  }

  return { job: envelope.job, fit: envelope.fit };
}
