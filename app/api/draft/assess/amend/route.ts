/**
 * "I do have that" — add what the fit check said was missing, then judge again.
 *
 * The fit check's most useful output is a list of things the posting wants that the
 * profile cannot show, and for a real person some of that list is not a gap: they have
 * done it and never wrote it down. This is the shortest path from noticing that to a
 * resume that reflects it — a sentence, saved into the profile properly, and the same
 * verdict recomputed against the profile as it now stands.
 *
 * Three things happen here and the order matters:
 *
 *   1. The sentence becomes candidate records (lib/profile/claim.ts) and is then filtered
 *      against the user's own words. Nothing the sentence does not support survives.
 *   2. What survives is written by lib/import/commit.ts — the same path the resume
 *      importer uses, so the fields are validated, the content hash is computed here
 *      rather than trusted, duplicates are refused, and every record leaves an audit row.
 *      One further audit row records the sentence itself, because "where did this come
 *      from" should be answerable in one place (REQ-10.1).
 *   3. The fit check runs again on the reloaded profile and a fresh sealed assessment is
 *      returned, so the draft that follows uses the new verdict and cannot be started
 *      from the stale one.
 *
 * The response is plain JSON rather than a stream: it is one short step, and the browser
 * shows a pending state for it. The whole request runs on the assessment's clock, since
 * it does the same work plus one extraction and renders nothing.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { DRAFT_BUDGET, DraftBudget } from '@/lib/ai/budget';
import { ASSESS_RESERVE_MS, ASSESS_TIME_BUDGET_MS } from '@/lib/pipeline/run';
import { assertDailyBudget, recordDailyUsage } from '@/lib/ai/daily-budget';
import {
  MAX_CLAIM_CHARS,
  MIN_CLAIM_CHARS,
  extractClaims,
  groundClaims,
  toCommitPayload,
} from '@/lib/profile/claim';
import { CommitPayloadSchema, commitImport } from '@/lib/import/commit';
import { audit, loadProfileForUser } from '@/lib/server/profile';
import { gatherFitFacts } from '@/lib/fit/assess';
import { runFitAgent } from '@/lib/fit/agent';
import { AssessmentTokenError, openAssessment, sealAssessment } from '@/lib/fit/token';
import { jsonError } from '@/lib/server/job-submission';
import { JSON_MAX_BYTES, guardMutation, readJsonLimited } from '@/lib/server/request-guard';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return jsonError('Sign in first.', 401);
  const refused = guardMutation(req, { contentTypes: ['application/json'], maxBytes: JSON_MAX_BYTES });
  if (refused) return refused;

  const read = await readJsonLimited(req, JSON_MAX_BYTES);
  if (!read.ok) return read.res;
  const body = (read.value && typeof read.value === 'object' ? read.value : {}) as { assessment?: unknown; text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';

  if (text.length < MIN_CLAIM_CHARS) {
    return jsonError('Say a little more about what you have done.', 400);
  }
  if (text.length > MAX_CLAIM_CHARS) {
    return jsonError(
      `That is longer than this box is for — keep it under ${MAX_CLAIM_CHARS} characters, or add it on your profile page.`,
      400,
    );
  }

  // The job comes from the sealed fit check, so the re-check is against the same posting
  // and the browser cannot substitute a different one.
  let assessed: ReturnType<typeof openAssessment>;
  try {
    assessed = openAssessment(body.assessment, userId);
  } catch (err) {
    if (err instanceof AssessmentTokenError) return jsonError(err.message, 400);
    throw err;
  }

  await assertDailyBudget(userId);
  const budget = new DraftBudget(DRAFT_BUDGET, ASSESS_TIME_BUDGET_MS, ASSESS_RESERVE_MS);
  budget.userId = userId;

  try {
    const missing = assessed.fit.skills.missing;

    let grounded;
    try {
      const claim = await extractClaims({ text, wanted: missing, budget });
      grounded = groundClaims(claim, text);
    } catch (err) {
      console.error('[amend] could not read what the user wrote, for user', userId, err);
      return jsonError(
        'Could not read that just now — the AI providers are busy. Try again in a minute, or add it on your profile page.',
        503,
      );
    }

    if (grounded.records.length === 0 && grounded.roles.length === 0) {
      return Response.json({
        added: null,
        dropped: grounded.dropped,
        unplaced: grounded.unplaced,
        message:
          grounded.dropped.length > 0
            ? 'Nothing was added — see below for what could not be taken from that.'
            : 'Nothing in that could be turned into a profile entry. Try naming the skill and where you used it.',
      });
    }

    // Re-validated by the same schema the importer's own payloads pass through, because
    // this payload was assembled from a model's output rather than from a form.
    const payload = CommitPayloadSchema.parse({ ...toCommitPayload(grounded), contact: null });
    const summary = await commitImport(userId, payload, 'manual');

    // What the record rows cannot say on their own: which sentence produced them.
    await audit(userId, null, 'create', 'manual', {
      via: 'fit-prompt',
      prompt: text.slice(0, 1_000),
      created: summary.created,
      rolesCreated: summary.rolesCreated,
    });

    // Judged again on the profile as it now stands — reloaded, not patched in memory.
    const profile = await loadProfileForUser(userId);
    const facts = gatherFitFacts({
      job: assessed.job,
      records: profile.records,
      roles: profile.roles,
      contact: profile.contact,
    });
    const fit = await runFitAgent({
      job: assessed.job,
      // The posting's own text is not stored (it is never stored), so the re-check reads
      // the requirements the first pass extracted from it. Eligibility rules already
      // judged are carried by those; a knockout cannot be invented here because it must
      // still appear in this text to survive grounding.
      jobText: [
        assessed.job.roleTitle,
        assessed.job.company ?? '',
        ...assessed.job.requiredSkills,
        ...assessed.job.preferredSkills,
        ...assessed.job.responsibilities,
        assessed.job.companyContext ?? '',
      ].join('\n'),
      facts,
      budget,
    });

    return Response.json({
      added: summary.message,
      dropped: grounded.dropped,
      unplaced: grounded.unplaced,
      fit,
      token: sealAssessment(userId, assessed.job, fit),
    });
  } catch (err) {
    console.error('[amend] failed for user', userId, err);
    return jsonError('That could not be saved. Nothing was changed — try again.', 500);
  } finally {
    // Charged whatever happened: the extraction and the re-check were paid for even when
    // the request ended badly.
    await recordDailyUsage(userId, budget.snapshot());
  }
}
