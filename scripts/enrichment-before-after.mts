/**
 * How many draft questions the old rule shows versus the new one, on a real profile.
 *
 * READ-ONLY. Selects only — nothing here writes, so it is safe against production. It
 * reads the user's open enrichment rows (which ARE the old intake's output), the approved
 * profile, and the job of their most recent drafts, then applies:
 *
 *   old   what /profile showed before: open rows whose gap is still open (`isGapOpen`),
 *         rationed to three.
 *   new   the same, then `qualifyQuestions` against the job — every row it removes is
 *         printed with the rule that removed it, so the number can be checked by eye.
 *
 * Also lists records already filed as a skill that `classifyRecordType` would file
 * elsewhere — the misfiling lib/profile/record-type.ts exists to stop.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/enrichment-before-after.mts <email> [envPath]
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import type { JobRequirement, ProfileRecord } from '../lib/types';
import {
  isGapOpen,
  qualifyQuestions,
  questionQualifies,
  rationedSlice,
  reachableRecordIds,
  QUESTIONS_SHOWN,
  type QuestionKind,
} from '../lib/profile/enrichment';
import { classifyRecordType } from '../lib/profile/record-type';

config({ path: process.argv[3] ?? '.env' });
const email = process.argv[2];
if (!email) {
  console.error('usage: enrichment-before-after.mts <email> [envPath]');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const [user] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
if (!user) throw new Error(`no user ${email}`);

const recordRows = await sql<
  Array<{
    id: string; type: string; data: Record<string, unknown>; tags: string[] | null;
    source: string; content_hash: string; flagged_for_removal: boolean; review_state: string;
  }>
>`select id, type, data, tags, source, content_hash, flagged_for_removal, review_state
  from profile_record where user_id = ${user.id} and review_state = 'approved'`;

const questionRows = await sql<
  Array<{ id: string; kind: string; record_id: string | null; topic: string; subject_key: string;
          priority: number; state: string; quote: string }>
>`select id, kind, record_id, topic, subject_key, priority, state, quote
  from enrichment_question where user_id = ${user.id}`;

const snapshots = await sql<Array<{ job: Record<string, unknown> | null; created_at: Date }>>`
  select job_requirement as job, created_at from resume_snapshot
  where user_id = ${user.id} order by created_at desc limit 5`;
await sql.end();

const records: ProfileRecord[] = recordRows.map(
  (r) =>
    ({
      id: r.id, userId: user.id, source: r.source, contentHash: r.content_hash,
      tags: r.tags ?? [], flaggedForRemoval: r.flagged_for_removal,
      reviewState: r.review_state, type: r.type, ...r.data,
    }) as unknown as ProfileRecord,
);

const usable = (j: Record<string, unknown> | null): j is Record<string, unknown> =>
  Boolean(j && Array.isArray(j.atsKeywords) && Array.isArray(j.requiredSkills) && Array.isArray(j.preferredSkills));
const jobs = snapshots.filter((s) => usable(s.job)).map((s) => s.job as unknown as JobRequirement);

const byState = questionRows.reduce<Record<string, number>>((m, q) => ((m[q.state] = (m[q.state] ?? 0) + 1), m), {});
console.log(`\n${email}: ${records.length} approved records, ${questionRows.length} question rows`, byState);
console.log(`${snapshots.length} recent snapshots, ${jobs.length} with a usable job\n`);

const open = questionRows
  .filter((q) => q.state === 'open')
  .map((q) => ({
    id: q.id, kind: q.kind as QuestionKind, recordId: q.record_id, topic: q.topic,
    subjectKey: q.subject_key, priority: q.priority, quote: q.quote,
  }));
const live = open.filter((q) => isGapOpen(q, records));

console.log(`OLD  open rows: ${open.length}; still-open gaps: ${live.length}; shown: ${rationedSlice(live, QUESTIONS_SHOWN).length}`);
for (const q of rationedSlice(live, QUESTIONS_SHOWN)) console.log(`       ${q.kind.padEnd(7)} ${q.subjectKey.slice(0, 60)}  "${q.quote.slice(0, 60)}"`);

for (const [i, job] of (jobs.length ? jobs : [null]).entries()) {
  const label = job ? `${job.roleTitle}${job.company ? ` @ ${job.company}` : ''}` : '(no job)';
  const audience = { records, job };
  const reach = job ? reachableRecordIds(records, job) : undefined;
  const kept = qualifyQuestions(live, audience);
  console.log(`\nNEW  vs job #${i + 1} ${label}: qualify ${kept.length} of ${live.length}; shown: ${rationedSlice(kept, QUESTIONS_SHOWN).length}`);
  for (const q of live) {
    const v = questionQualifies(q, audience, reach);
    console.log(`       ${v.ok ? 'KEEP' : 'drop'} ${q.kind.padEnd(7)} ${(q.topic || q.quote).slice(0, 48).padEnd(48)} ${v.why}`);
  }
}

// ------------------------------------------------------------------ misfilings --
const misfiled = records
  .filter((r) => r.type === 'skill')
  .map((r) => ({ r, name: String((r as unknown as { name?: string }).name ?? '') }))
  .map(({ r, name }) => ({ r, name, verdict: classifyRecordType({ name }) }))
  .filter(({ verdict }) => verdict.type && verdict.type !== 'skill');
console.log(`\nSkill records the rules would file elsewhere: ${misfiled.length}`);
for (const m of misfiled) console.log(`       "${m.name}" -> ${m.verdict.type} (${m.verdict.why})`);

const notSkills = questionRows
  .filter((q) => q.kind === 'skill')
  .map((q) => ({ q, verdict: classifyRecordType({ name: q.topic }) }))
  .filter(({ verdict }) => verdict.type !== 'skill');
console.log(`\nSkill questions (any state) whose topic the rules do not place as a skill: ${notSkills.length}`);
for (const n of notSkills) console.log(`       [${n.q.state}] "${n.q.topic}" -> ${n.verdict.type ?? 'unplaced'}`);
