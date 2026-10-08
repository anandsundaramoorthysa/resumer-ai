/**
 * Cover letter and interview prep for an existing resume — REQ-4.5.
 *
 * Both reuse the resume that was already generated and verified, so neither needs a
 * fresh retrieval pass. Generated on demand rather than during the draft: most drafts
 * never need either, and making every resume pay for them would be wasteful.
 */

import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { resumeSnapshots } from '@/lib/db/schema';
import { BudgetExceededError, DraftBudget } from '@/lib/ai/budget';
import { assertDailyBudget, recordDailyUsage } from '@/lib/ai/daily-budget';
import { generateCoverLetter, coverLetterToText } from '@/lib/generate/cover-letter';
import { generateInterviewPrep } from '@/lib/generate/interview';
import { userMessage } from '@/lib/server/user-message';
import { guardMutation, isSafeId, readJsonLimited } from '@/lib/server/request-guard';
import type { JobRequirement, ResumeDocument } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ snapshotId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 });

  const refused = guardMutation(req, { contentTypes: ['application/json'], maxBytes: 4096 });
  if (refused) return refused;

  const { snapshotId } = await ctx.params;
  if (!isSafeId(snapshotId)) return Response.json({ error: 'Not found.' }, { status: 404 });
  const read = await readJsonLimited(req, 4096);
  if (!read.ok) return read.res;
  const body = (read.value && typeof read.value === 'object' ? read.value : {}) as { kind?: string };
  const kind = body.kind === 'interview' ? 'interview' : 'cover-letter';

  const [row] = await db
    .select()
    .from(resumeSnapshots)
    .where(
      and(eq(resumeSnapshots.id, snapshotId), eq(resumeSnapshots.userId, userId)),
    )
    .limit(1);

  if (!row) return Response.json({ error: 'Not found.' }, { status: 404 });

  const doc = row.document as unknown as ResumeDocument;
  const job = row.jobRequirement as unknown as JobRequirement | null;

  if (!job) {
    return Response.json(
      {
        error:
          'This is a baseline resume with no job attached, so there is nothing to tailor a letter or interview prep against.',
      },
      { status: 400 },
    );
  }

  // Cover letters and interview prep are unlimited per snapshot and cost a model call
  // each, so they count against the same daily ceiling a draft does.
  try {
    await assertDailyBudget(userId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return Response.json({ error: err.message }, { status: err.scope === 'approval' ? 403 : 429 });
    }
    throw err;
  }

  const budget = new DraftBudget();
  budget.userId = userId;

  try {
    if (kind === 'interview') {
      const prep = await generateInterviewPrep(doc, job, budget);
      return Response.json({ kind, prep });
    }

    const letter = await generateCoverLetter(doc, job, budget);
    return Response.json({
      kind,
      letter,
      text: coverLetterToText(letter, doc),
    });
  } catch (err) {
    // Raw `err.message` is a provider's error or a query with SQL in it; log it, say less.
    console.error('[extras] generation failed for user', userId, err);
    return Response.json(
      { error: userMessage(err, 'Generation failed. Try again in a minute.') },
      { status: 500 },
    );
  } finally {
    await recordDailyUsage(userId, budget.snapshot());
  }
}
