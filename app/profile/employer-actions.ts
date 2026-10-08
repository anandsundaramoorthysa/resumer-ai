'use server';

/**
 * Sharpening one job's bullets from the web — the server half.
 *
 * Two read paths and one write path, and the split between them is the product rule:
 *
 *   findMyEvidenceForRole     PRIMARY. Searches for what the user has published about this
 *                             job themselves (lib/profile/self-evidence.ts). Writes nothing.
 *   researchEmployerForRole   Reads a company page the user pasted, for context about the
 *                             employer (lib/profile/employer-context.ts). Writes nothing.
 *   applyEmployerRewrite      Writes ONE bullet, the one the user clicked Add on.
 *
 * That is the shape the import review already has, for the same reason — the user has to
 * see where a fact came from before it is in their profile.
 *
 * Both read paths spend AI and network, so both sit inside the limits every other such
 * path does: `assertDailyBudget` (which is also the burst limiter and the approval gate),
 * a small `DraftBudget` whose clock fits Netlify's 30 seconds with the search or scrape's
 * 12 in front of the model call, and `recordDailyUsage` in a finally so a failed call is
 * still counted.
 */

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { contactInfo, profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { DraftBudget } from '@/lib/ai/budget';
import { assertDailyBudget, recordDailyUsage } from '@/lib/ai/daily-budget';
import {
  researchEmployer,
  rewriteAsParts,
  type EmployerContext,
  type EmployerRole,
  type RewriteProposal,
  type RoleBullet,
} from '@/lib/profile/employer-context';
import { findSelfEvidence, type SelfEvidence } from '@/lib/profile/self-evidence';
import { loadProfileForUser } from '@/lib/server/profile';
import { recordEnrichmentQuestions } from '@/lib/server/enrichment';
import { missingBulletParts } from '@/lib/profile/enrichment';
import { updateBullet } from '@/lib/profile/records';
import type { ProfileRecord } from '@/lib/types';
import { userMessage } from '@/lib/server/user-message';
import type { Result } from './record-actions';

/** Two model calls' worth of room: one is used, the second covers a chain fallback. */
const RESEARCH_BUDGET = { maxCalls: 2, maxTokens: 60_000 };
/**
 * The whole path's clock. Up to 12 seconds of it go to the search or the scrape, which
 * `DraftBudget.callDeadlineMs` then subtracts from the model call — so the call gets what
 * is actually left instead of a fixed allowance that outlives the function.
 */
const RESEARCH_TIME_MS = 24_000;

async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

type Loaded =
  | { ok: true; role: EmployerRole; bullets: RoleBullet[] }
  | { ok: false; message: string };

/** The job and its bullets, from the live rows — owned by this user or nothing. */
async function loadRoleBullets(userId: string, roleId: string): Promise<Loaded> {
  const [role] = await db
    .select()
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.userId, userId)))
    .limit(1);
  if (!role) return { ok: false, message: 'That job is no longer in your profile.' };

  const rows = await db
    .select()
    .from(profileRecords)
    .where(and(eq(profileRecords.userId, userId), eq(profileRecords.type, 'experience-bullet')));

  const bullets: RoleBullet[] = rows
    .filter((r) => String((r.data as Record<string, unknown>).roleId ?? '') === roleId)
    // Only the lines the profile page shows (approved, not flagged). Pending and rejected
    // rows used to come too: a line the user had already rejected was sent to the model,
    // offered back as a proposal, and "Added" to a row that stays rejected and never shows.
    .filter((r) => r.reviewState === 'approved' && !r.flaggedForRemoval)
    .map((r) => {
      const data = r.data as Record<string, unknown>;
      return {
        recordId: r.id,
        text: String(data.text ?? data.action ?? ''),
        // The live record decides what is missing, not the research — the same rule the
        // enrichment queue follows, so a gap closed in the bullet editor is not re-asked.
        missing: missingBulletParts({ ...(data as object), id: r.id, type: 'experience-bullet' } as ProfileRecord),
      };
    })
    .filter((b) => b.text.trim().length > 0);

  if (bullets.length === 0) {
    return {
      ok: false,
      message: 'Write what you did in this job first — there is nothing here to sharpen yet.',
    };
  }
  return { ok: true, role: { title: role.title, company: role.company }, bullets };
}

/** Runs one read path inside the budget, files its questions, and never throws. */
async function withinBudget<T extends { proposals: RewriteProposal[] }>(
  userId: string,
  run: (budget: DraftBudget) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const budget = new DraftBudget(RESEARCH_BUDGET, RESEARCH_TIME_MS, 1_000);
  budget.userId = userId;
  try {
    await assertDailyBudget(userId);
    const value = await run(budget);
    await fileQuestions(userId, value.proposals);
    revalidatePath('/profile');
    return { ok: true, value };
  } catch (err) {
    // Through userMessage, like every other AI path: the raw message of an
    // AllProvidersFailedError lists each provider's own error text, and it was being put
    // on the profile page verbatim.
    console.warn('[employer-context] research failed:', err instanceof Error ? err.message.slice(0, 300) : err);
    return { ok: false, message: userMessage(err, 'That did not work. Try again in a moment.') };
  } finally {
    await recordDailyUsage(userId, budget.snapshot());
  }
}

export type EvidenceResult = { ok: true; evidence: SelfEvidence } | { ok: false; message: string };

/** What the user has published about this job themselves. The primary path. */
export async function findMyEvidenceForRole(roleId: string): Promise<EvidenceResult> {
  const userId = await requireUserId();
  const loaded = await loadRoleBullets(userId, roleId);
  if (!loaded.ok) return loaded;

  const [contact] = await db
    .select({ fullName: contactInfo.fullName })
    .from(contactInfo)
    .where(eq(contactInfo.userId, userId))
    .limit(1);

  const out = await withinBudget(userId, (budget) =>
    findSelfEvidence({
      fullName: contact?.fullName ?? '',
      role: loaded.role,
      bullets: loaded.bullets,
      budget,
    }),
  );
  return out.ok ? { ok: true, evidence: out.value } : out;
}

export type ResearchResult = { ok: true; context: EmployerContext } | { ok: false; message: string };

/** Context about the employer, from a page the user pasted. */
export async function researchEmployerForRole(roleId: string, url: string): Promise<ResearchResult> {
  const userId = await requireUserId();
  const loaded = await loadRoleBullets(userId, roleId);
  if (!loaded.ok) return loaded;

  const out = await withinBudget(userId, (budget) =>
    researchEmployer({ role: loaded.role, bullets: loaded.bullets, url, budget }),
  );
  return out.ok ? { ok: true, context: out.value } : out;
}

/**
 * A refused rewrite becomes a question in the queue that already exists.
 *
 * `rejectedRewrites` is precisely what this is: a line the model believed it could
 * strengthen and the grounding guard stopped. Filing it there rather than inventing a
 * second queue means the question survives this page load, is never asked twice, closes
 * itself when the user fills the gap anywhere else, and is answered through the path that
 * writes the answer verbatim as a manual record. A failure here is swallowed: the
 * proposals on screen are worth more than the note about them.
 */
async function fileQuestions(userId: string, proposals: RewriteProposal[]): Promise<void> {
  const refused = proposals.filter((p) => p.after === null && p.violations.length > 0 && p.question);
  if (refused.length === 0) return;
  try {
    const profile = await loadProfileForUser(userId);
    await recordEnrichmentQuestions(
      userId,
      {
        rejectedRewrites: refused.map((p) => ({ recordId: p.recordId, text: p.before })),
        weakBullets: [],
        genuineGaps: [],
        document: null,
        job: null,
      },
      profile.records,
      profile.roles,
    );
  } catch (err) {
    console.warn(
      '[employer-context] could not file the questions:',
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
  }
}

/**
 * Applies one proposal, on one explicit click.
 *
 * The rewrite becomes the bullet's `action`; a stored `scale` or `outcome` it already
 * states is dropped so it is not printed twice, and one it left out is kept, because the
 * user typed it (rewriteAsParts). `updateBullet` does the rest — it recomposes the
 * text, rehashes it, promotes the row to `manual` so no sync competes with the edit, and
 * writes the audit entry.
 *
 * The text is not re-grounded here, deliberately. The guard exists to stop a MODEL putting
 * words in the user's mouth unseen; this is the user, having read the sentence and its
 * sources, choosing to say it — the same authority the bullet editor gives them.
 */
export async function applyEmployerRewrite(recordId: string, text: string): Promise<Result> {
  const userId = await requireUserId();
  const action = text.trim().slice(0, 1_000);
  if (!action) return { ok: false, message: 'There is nothing to save.' };

  const [row] = await db
    .select({ data: profileRecords.data })
    .from(profileRecords)
    .where(
      and(
        eq(profileRecords.id, recordId),
        eq(profileRecords.userId, userId),
        eq(profileRecords.type, 'experience-bullet'),
        eq(profileRecords.reviewState, 'approved'),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, message: 'That entry no longer exists.' };

  const data = row.data as Record<string, unknown>;
  try {
    await updateBullet(userId, recordId, {
      roleId: String(data.roleId ?? ''),
      // Not "action = rewrite, scale and outcome as stored": the rewrite is of the whole
      // sentence, so that printed the scale and outcome twice (see rewriteAsParts).
      ...rewriteAsParts(action, {
        scale: data.scale ? String(data.scale) : undefined,
        outcome: data.outcome ? String(data.outcome) : undefined,
      }),
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not save that.' };
  }

  revalidatePath('/profile');
  return { ok: true, message: 'Saved.' };
}
