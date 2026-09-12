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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  enrichmentPreferences,
  enrichmentQuestions,
  profileRecords,
  resumeSnapshots,
} from '@/lib/db/schema';
import type { JobRequirement, ProfileRecord, RoleRecord } from '@/lib/types';
import { audit } from '@/lib/server/profile';
import {
  buildEnrichmentQuestions,
  isGapOpen,
  missingBulletParts,
  qualifyQuestions,
  rationedSlice,
  selectNewQuestions,
  QUESTIONS_SHOWN,
  type BulletPart,
  type EnrichmentSignal,
  type QuestionKind,
} from '@/lib/profile/enrichment';
import { createSkill, setProjectMetrics, updateBullet } from '@/lib/profile/records';
import { suggestedSkillCategory } from '@/lib/skills/categories';
import { classifyRecordType } from '@/lib/profile/record-type';

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

/* ------------------------------------------------- whether to ask at all -- */

/**
 * How much the user wants to be asked.
 *
 *   all           the backlog as it has always worked.
 *   current-job   only questions this most recent draft raised. The backlog still exists
 *                 and still refreshes, but /profile shows nothing about last month's
 *                 posting — which is the owner's own phrasing of what they wanted.
 *   off           nothing is shown and no draft adds anything.
 */
export const ENRICHMENT_MODES = ['all', 'current-job', 'off'] as const;
export type EnrichmentMode = (typeof ENRICHMENT_MODES)[number];

export function isEnrichmentMode(value: unknown): value is EnrichmentMode {
  return typeof value === 'string' && (ENRICHMENT_MODES as readonly string[]).includes(value);
}

/**
 * What this user chose, or `all`.
 *
 * Swallows the error on purpose, and only this one: `enrichment_preference` ships before
 * its migration runs on production (scripts/2026-09-12-enrichment-preference.sql), and a
 * relation that does not exist yet must read as "they have not chosen anything", not as a
 * 500 on the profile page. Remove the catch once the migration is applied and this becomes
 * an ordinary select.
 */
export async function loadEnrichmentMode(userId: string): Promise<EnrichmentMode> {
  try {
    const [row] = await db
      .select({ mode: enrichmentPreferences.mode })
      .from(enrichmentPreferences)
      .where(eq(enrichmentPreferences.userId, userId))
      .limit(1);
    return isEnrichmentMode(row?.mode) ? row.mode : 'all';
  } catch {
    return 'all';
  }
}

export async function setEnrichmentMode(userId: string, mode: EnrichmentMode): Promise<void> {
  await db
    .insert(enrichmentPreferences)
    .values({ userId, mode })
    .onConflictDoUpdate({
      target: enrichmentPreferences.userId,
      set: { mode, updatedAt: new Date() },
    });
}

/**
 * How many drafts have re-derived each open question.
 *
 * Raw SQL, and `asked_count` is deliberately NOT in lib/db/schema.ts: every other read of
 * this table uses `db.select()` over the declared columns, so declaring a column that
 * production does not have yet would break the profile page for everyone until the
 * migration ran. Here the absence is caught and read as "no count recorded", which
 * degrades to the old behaviour — the patience test simply never fires. Move it into the
 * schema and delete the catch once the migration is applied.
 */
async function askedCounts(userId: string): Promise<Map<string, number>> {
  try {
    const rows = await db.execute<{ subject_key: string; asked_count: number }>(
      sql`select subject_key, asked_count from enrichment_question
          where user_id = ${userId} and state = 'open'`,
    );
    const out = new Map<string, number>();
    for (const r of rows as unknown as Array<{ subject_key: string; asked_count: number }>) {
      out.set(r.subject_key, Number(r.asked_count) || 0);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Bumps the count for questions this draft raised again. Silent if not migrated. */
async function countAsked(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db.execute(
      sql`update enrichment_question set asked_count = asked_count + 1
          where user_id = ${userId}
            and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
    );
  } catch {
    /* column not migrated yet — the patience test stays off, nothing else changes. */
  }
}

/**
 * The posting the most recent draft was for, and when that draft happened.
 *
 * The queue lives on /profile, which knows nothing about any job — so "would a resume for
 * the job you are actually applying for use this record?" has to be answered from the last
 * snapshot. Shape-checked rather than trusted: `job_requirement` is jsonb written by
 * several versions of the extractor, and `rankRecords` indexes `atsKeywords` unguarded.
 */
async function latestDraftContext(
  userId: string,
): Promise<{ job: JobRequirement | null; at: Date | null }> {
  const [row] = await db
    .select({ job: resumeSnapshots.jobRequirement, at: resumeSnapshots.createdAt })
    .from(resumeSnapshots)
    .where(eq(resumeSnapshots.userId, userId))
    .orderBy(desc(resumeSnapshots.createdAt))
    .limit(1);
  if (!row) return { job: null, at: null };

  const raw = row.job as Record<string, unknown> | null;
  const usable =
    raw &&
    Array.isArray(raw.atsKeywords) &&
    Array.isArray(raw.requiredSkills) &&
    Array.isArray(raw.preferredSkills);
  return { job: usable ? (raw as unknown as JobRequirement) : null, at: row.at };
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
  // Turned off means no new backlog. Stale rows are still swept below, because a question
  // about a gap the user has since closed is wrong whether or not they want to be asked.
  const mode = await loadEnrichmentMode(userId);

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
  if (mode === 'off') return { added: 0, closed: stale.length };

  const drafted = buildEnrichmentQuestions(signal, records, roles);

  // A question already open on the same subject gets its priority refreshed rather than
  // duplicated. That is what makes the queue re-sort against the job being applied for
  // now: a bullet nobody cared about last week outranks everything the moment a posting
  // makes it the reason the score is stuck.
  const openBySubject = new Map(
    survivors.filter((q) => q.state === 'open').map((q) => [q.subjectKey, q.id]),
  );
  const reAsked: string[] = [];
  for (const q of drafted) {
    const id = openBySubject.get(q.subjectKey);
    if (!id) continue;
    reAsked.push(id);
    await db
      .update(enrichmentQuestions)
      .set({ priority: q.priority, reason: q.reason, updatedAt: new Date() })
      .where(and(eq(enrichmentQuestions.userId, userId), eq(enrichmentQuestions.id, id)));
  }
  // One more draft has put these in front of the user. Past MAX_TIMES_ASKED the answer is
  // that they are not going to answer this one, and it stops being shown.
  await countAsked(userId, reAsked);

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
): Promise<{ shown: QueuedQuestion[]; total: number; mode: EnrichmentMode }> {
  const mode = await loadEnrichmentMode(userId);
  if (mode === 'off') return { shown: [], total: 0, mode };

  const rows = await db
    .select()
    .from(enrichmentQuestions)
    .where(
      and(eq(enrichmentQuestions.userId, userId), eq(enrichmentQuestions.state, 'open')),
    );

  const byId = new Map(records.map((r) => [r.id, r]));
  const [{ job, at: lastDraftAt }, asked] = await Promise.all([
    latestDraftContext(userId),
    askedCounts(userId),
  ]);

  const live = rows
    // "Only ask about the job I am drafting for" — a row this latest draft did not touch
    // is about a posting the user has moved on from. It stays open and keeps refreshing,
    // so switching back to `all` brings the whole backlog back unchanged.
    .filter((r) => mode !== 'current-job' || !lastDraftAt || r.updatedAt >= lastDraftAt)
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

  /*
   * The same qualification the intake applies, re-applied against the job in hand.
   *
   * Intake judged each question against the posting of the draft that raised it; weeks of
   * drafts later, the backlog is full of rows whose records no longer reach a resume for
   * anything the user is applying to, and of keywords the scorer named that nobody can
   * claim to have ("Remote", "India", a seniority word). Those are exactly the questions
   * the owner said do not help. `total` counts what survives, so the "and N more" line on
   * /profile counts questions that could still change a draft rather than all of them.
   */
  const useful = qualifyQuestions(live, {
    records,
    job,
    timesAsked: (key) => asked.get(key) ?? 0,
  });

  // Rationed rather than sliced, for the reason recorded on `rationedSlice`: the top
  // three by impact were all keyword gaps on the profile this was built for, so the
  // first thing the user saw never mentioned a line they had written.
  return { shown: rationedSlice(useful, QUESTIONS_SHOWN), total: useful.length, mode };
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

  /*
   * Where the answer is filed is decided, not assumed.
   *
   * This branch used to call `createSkill` for every keyword the posting had named, with
   * `suggestedSkillCategory(topic) ?? 'tool'` for the category. Measured against the real
   * classifier, `classifySkill` returns null for "AWS Certified Solutions Architect",
   * "Certified Scrum Master", "Six Sigma Black Belt" and "Google Analytics Certified" — so
   * each of them became a skill of category `tool` and printed in the Skills section under
   * "tools". A certification filed as a tool is both the wrong section and a smaller claim
   * than the truth, and the user cannot see that it happened.
   *
   * `classifyRecordType` settles it instead (lib/profile/record-type.ts). A keyword it
   * places somewhere other than `skill` is refused with the section it belongs in, and
   * nothing is written: "where did you use it?" is the wrong question for a certificate,
   * and its answer cannot supply the issuer a certification requires or the venue a
   * publication does. Storing it half-formed, or as a skill, would be the guess this
   * exists to stop. New questions of this shape are no longer asked at all —
   * `isAskableSkill` rejects them at intake — so this only meets rows queued before that
   * rule existed, and the card keeps its "don't ask again" button for them.
   */
  const filed = classifyRecordType({ name: question.topic }).type;
  if (filed && filed !== 'skill') {
    throw new Error(
      `${question.topic} is a${filed === 'award' || filed === 'education' ? 'n' : ''} ${filed}, not a skill — add it under that section of your profile so it prints in the right place.`,
    );
  }

  const recordId = await createSkill(userId, {
    name: question.topic,
    category: suggestedSkillCategory(question.topic) ?? 'tool',
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
