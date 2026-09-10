/**
 * Persisting, serving and settling the enrichment queue.
 *
 * The rule the queue follows, in one place, because it is spread over four call sites
 * otherwise:
 *
 *   APPEARS   after a draft, when the pipeline's own signal named a deficiency on a
 *             specific record (lib/profile/enrichment.ts decides which and how many),
 *             and no question with that subject key exists for this user in any state.
 *   SHOWN     while `state = 'open'` AND the gap is still open against the LIVE profile.
 *             The second half is why a gap closed in the bullet editor, or by a sync, or
 *             by anything else takes its question down without the queue being told.
 *   ANSWERED  the answer is written into the profile as a manual record, the row becomes
 *             a tombstone pointing at what it produced, and it is never asked again.
 *   SKIPPED   the row becomes a tombstone with no answer. Also never asked again — the
 *             same decision lib/server/sync-review.ts makes about a rejected proposal,
 *             for the same reason: a queue that refills with things you have already
 *             decided about is one people stop reading, and a queue nobody reads is
 *             worse than no queue, because the profile stays thin either way.
 *   IGNORED   left alone. It stays open, is never duplicated, and each later draft
 *             refreshes its priority — so a question rises when the job you are applying
 *             for today happens to care about it.
 *   DELETED   the record it concerns is deleted: the row goes with it, by foreign key.
 *             A question about a fact that no longer exists is noise. `isGapOpen` says
 *             the same thing independently, so a row that outran the cascade still
 *             disappears from the page.
 *
 * The one thing an answer is NOT is licence. It is written verbatim as the user's own
 * words into the same `manual` records the hand-editors write, with the same provenance
 * — see lib/profile/records.ts on why `manual` is load-bearing. Nothing here asks a model
 * to interpret, expand or format an answer, so nothing reaches a resume that the user
 * did not type (NFR-8).
 */

import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { enrichmentQuestions, profileRecords } from '@/lib/db/schema';
import type { ProfileRecord, RoleRecord } from '@/lib/types';
import { audit } from '@/lib/server/profile';
import {
  buildEnrichmentQuestions,
  isGapOpen,
  missingBulletParts,
  rationedSlice,
  selectNewQuestions,
  QUESTIONS_SHOWN,
  type BulletPart,
  type EnrichmentSignal,
  type QuestionKind,
} from '@/lib/profile/enrichment';
import { createSkill, setProjectMetrics, updateBullet } from '@/lib/profile/records';

export interface QueuedQuestion {
  id: string;
  kind: QuestionKind;
  recordId: string | null;
  topic: string;
  quote: string;
  context: string;
  reason: string;
  priority: number;
  /**
   * Which parts of a bullet are still blank, recomputed from the live record.
   *
   * Not stored: a question asked when both were missing must not keep asking for the
   * scale after the outcome alone was supplied elsewhere, and the stored kind cannot
   * know that. The record is the authority on what is missing; the row only remembers
   * why we asked.
   */
  missing: BulletPart[];
}

/* --------------------------------------------------- writing what a draft found -- */

/**
 * Files this draft's findings against the records they concern.
 *
 * Runs after the draft is persisted, not during it: a question is a note about a resume
 * that already exists, and a failure here must never cost the user the resume. Callers
 * treat it that way — see app/api/draft/route.ts.
 */
export async function recordEnrichmentQuestions(
  userId: string,
  signal: EnrichmentSignal,
  records: ProfileRecord[],
  roles: RoleRecord[],
): Promise<{ added: number; closed: number }> {
  const existing = await db
    .select({
      id: enrichmentQuestions.id,
      subjectKey: enrichmentQuestions.subjectKey,
      kind: enrichmentQuestions.kind,
      recordId: enrichmentQuestions.recordId,
      topic: enrichmentQuestions.topic,
      state: enrichmentQuestions.state,
    })
    .from(enrichmentQuestions)
    .where(eq(enrichmentQuestions.userId, userId));

  // Gaps that closed since the last draft. Only open rows are swept: a tombstone is a
  // decision, and deleting it would let the same question come back.
  const stale = existing
    .filter((q) => q.state === 'open')
    .filter(
      (q) =>
        !isGapOpen(
          { kind: q.kind as QuestionKind, recordId: q.recordId, topic: q.topic },
          records,
        ),
    )
    .map((q) => q.id);

  if (stale.length > 0) {
    await db
      .delete(enrichmentQuestions)
      .where(
        and(
          eq(enrichmentQuestions.userId, userId),
          inArray(enrichmentQuestions.id, stale),
        ),
      );
  }

  const survivors = existing.filter((q) => !stale.includes(q.id));
  const drafted = buildEnrichmentQuestions(signal, records, roles);

  // A question already open on the same subject gets its priority refreshed rather than
  // duplicated. That is what makes the queue re-sort against the job being applied for
  // now: a bullet nobody cared about last week outranks everything the moment a posting
  // makes it the reason the score is stuck.
  const openBySubject = new Map(
    survivors.filter((q) => q.state === 'open').map((q) => [q.subjectKey, q.id]),
  );
  for (const q of drafted) {
    const id = openBySubject.get(q.subjectKey);
    if (!id) continue;
    await db
      .update(enrichmentQuestions)
      .set({ priority: q.priority, reason: q.reason, updatedAt: new Date() })
      .where(and(eq(enrichmentQuestions.userId, userId), eq(enrichmentQuestions.id, id)));
  }

  const fresh = selectNewQuestions(
    drafted,
    survivors.map((q) => q.subjectKey),
    openBySubject.size,
  );

  if (fresh.length > 0) {
    await db
      .insert(enrichmentQuestions)
      .values(
        fresh.map((q) => ({
          userId,
          recordId: q.recordId,
          subjectKey: q.subjectKey,
          kind: q.kind,
          topic: q.topic,
          quote: q.quote,
          context: q.context,
          reason: q.reason,
          priority: q.priority,
        })),
      )
      // The unique index on (user_id, subject_key) is the real guarantee; two drafts
      // finishing at once would otherwise race past the read above.
      .onConflictDoNothing();
  }

  return { added: fresh.length, closed: stale.length };
}

/* ----------------------------------------------------------------- reading it -- */

/**
 * The queue as /profile shows it: the top few, and an honest count of the rest.
 *
 * Filtered against the live records here rather than by SQL, because "is this gap still
 * open" is a question about profile content that only lib/profile/enrichment.ts can
 * answer, and duplicating it in a WHERE clause is how the two would drift apart.
 */
export async function loadEnrichmentQueue(
  userId: string,
  records: ProfileRecord[],
): Promise<{ shown: QueuedQuestion[]; total: number }> {
  const rows = await db
    .select()
    .from(enrichmentQuestions)
    .where(
      and(eq(enrichmentQuestions.userId, userId), eq(enrichmentQuestions.state, 'open')),
    );

  const byId = new Map(records.map((r) => [r.id, r]));

  const live = rows
    .map((r) => ({
      id: r.id,
      kind: r.kind as QuestionKind,
      recordId: r.recordId,
      topic: r.topic,
      quote: r.quote,
      context: r.context,
      reason: r.reason,
      priority: r.priority,
      subjectKey: r.subjectKey,
      missing: missingBulletParts(byId.get(r.recordId ?? '')),
    }))
    .filter((q) => isGapOpen(q, records));

  // Rationed rather than sliced, for the reason recorded on `rationedSlice`: the top
  // three by impact were all keyword gaps on the profile this was built for, so the
  // first thing the user saw never mentioned a line they had written.
  return { shown: rationedSlice(live, QUESTIONS_SHOWN), total: live.length };
}

/* --------------------------------------------------------------- settling it -- */

async function loadQuestion(userId: string, questionId: string) {
  const [row] = await db
    .select()
    .from(enrichmentQuestions)
    .where(
      and(eq(enrichmentQuestions.userId, userId), eq(enrichmentQuestions.id, questionId)),
    )
    .limit(1);
  return row ?? null;
}

/** Marks a question settled. Only an open one can be settled, so a stale page cannot
 * re-answer a question or un-skip one — the same guard sync-review puts on `pending`. */
async function settle(
  userId: string,
  questionId: string,
  state: 'answered' | 'dismissed',
  answer: string,
  answerRecordId: string | null,
): Promise<void> {
  await db
    .update(enrichmentQuestions)
    .set({
      state,
      answer: answer.slice(0, 600),
      answerRecordId,
      settledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(enrichmentQuestions.userId, userId),
        eq(enrichmentQuestions.id, questionId),
        eq(enrichmentQuestions.state, 'open'),
      ),
    );
}

export interface EnrichmentAnswer {
  /** A bullet's missing halves. */
  scale?: string;
  outcome?: string;
  /** A project's outcome, or where a skill was used. */
  text?: string;
}

/**
 * Writes an answer into the profile as a real, grounded fact.
 *
 * Each branch reuses the hand-editing path for its type rather than writing SQL of its
 * own — `updateBullet`, `setProjectMetrics`, `createSkill`. That is not tidiness: those
 * functions recompute the content hash, promote the row to `manual` so a later sync can
 * never overwrite what the user said, derive tags and write the audit entry. An answer
 * that skipped them would be a fact the rest of the system treats differently from the
 * identical one typed into the form two sections down the page.
 */
export async function answerEnrichmentQuestion(
  userId: string,
  questionId: string,
  answer: EnrichmentAnswer,
): Promise<void> {
  const question = await loadQuestion(userId, questionId);
  if (!question || question.state !== 'open') {
    throw new Error('That question has already been dealt with.');
  }

  const scale = (answer.scale ?? '').trim();
  const outcome = (answer.outcome ?? '').trim();
  const text = (answer.text ?? '').trim();

  if (question.kind === 'bullet') {
    if (!scale && !outcome) throw new Error('Write at least one of the two.');
    const [row] = await db
      .select({ data: profileRecords.data })
      .from(profileRecords)
      .where(
        and(
          eq(profileRecords.id, question.recordId ?? ''),
          eq(profileRecords.userId, userId),
        ),
      )
      .limit(1);
    if (!row) throw new Error('That entry no longer exists.');

    const data = row.data as Record<string, unknown>;
    // Merged, never replaced: a question about the missing outcome must not blank a
    // scale the user wrote months ago in the bullet editor.
    await updateBullet(userId, question.recordId!, {
      roleId: String(data.roleId ?? ''),
      action: String(data.action ?? data.text ?? ''),
      scale: scale || (data.scale ? String(data.scale) : undefined),
      outcome: outcome || (data.outcome ? String(data.outcome) : undefined),
    });
    await settle(
      userId,
      questionId,
      'answered',
      [scale, outcome].filter(Boolean).join(' · '),
      question.recordId,
    );
    return;
  }

  if (question.kind === 'project') {
    if (!text) throw new Error('Write what it achieved.');
    const [row] = await db
      .select({ data: profileRecords.data })
      .from(profileRecords)
      .where(
        and(
          eq(profileRecords.id, question.recordId ?? ''),
          eq(profileRecords.userId, userId),
        ),
      )
      .limit(1);
    if (!row) throw new Error('That project no longer exists.');

    const previous = (row.data as Record<string, unknown>).impactMetrics;
    const metrics = Array.isArray(previous) ? (previous as string[]) : [];
    // Appended. A project can have achieved more than one thing, and the outcomes list
    // is what lib/generate/assemble.ts prints under it.
    await setProjectMetrics(userId, question.recordId!, [...metrics, text]);
    await settle(userId, questionId, 'answered', text, question.recordId);
    return;
  }

  // A skill gap. The answer is an attestation, so it is required: a keyword the profile
  // could not evidence becomes a claim only because the user said, in their own words,
  // where they used it. A checkbox here would be a way to pad a Skills section by reflex,
  // and the Skills section is the heaviest thing the scorer reads.
  if (!text) throw new Error('Say where you used it.');
  const recordId = await createSkill(userId, {
    name: question.topic,
    category: 'tool',
    evidence: text,
  });
  await settle(userId, questionId, 'answered', text, recordId);
}

/** Skipping. A tombstone, so a later draft that finds the same gap does not re-ask. */
export async function dismissEnrichmentQuestion(
  userId: string,
  questionId: string,
): Promise<void> {
  const question = await loadQuestion(userId, questionId);
  if (!question || question.state !== 'open') return;
  await settle(userId, questionId, 'dismissed', '', null);
  await audit(userId, question.recordId, 'update', 'manual', {
    enrichmentQuestion: question.subjectKey,
    skippedByUser: true,
  });
}
