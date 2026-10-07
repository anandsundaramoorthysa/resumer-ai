/**
 * lib/server/enrichment.ts against a real Postgres engine: a question is recorded once,
 * stops being shown after MAX_TIMES_ASKED, and answering or skipping it closes it for good.
 */
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { all, mkRecord, mkRole, mkUser, one } from './db/seed.mjs';
import {
  answerEnrichmentQuestion,
  dismissEnrichmentQuestion,
  loadEnrichmentMode,
  loadEnrichmentQueue,
  recordEnrichmentQuestions,
  setEnrichmentMode,
} from '../lib/server/enrichment';
import { MAX_TIMES_ASKED } from '../lib/profile/enrichment';
import type { EnrichmentSignal } from '../lib/profile/enrichment';
import type { ProfileRecord, RoleRecord } from '../lib/types';

const t = await installTestDb();
const { pg } = t;

const role = (id: string, userId: string): RoleRecord =>
  ({ id, userId, title: 'Platform Engineer', company: 'Northwind', startDate: '2021-03', endDate: 'present', source: 'manual', contentHash: `h-${id}`, reviewState: 'approved' }) as RoleRecord;

/** A user with one approved job and one bullet that has neither scale nor outcome. */
async function world() {
  const userId = await mkUser(pg);
  const roleId = await mkRole(pg, userId, { state: 'approved', source: 'manual' });
  const data = { roleId, text: 'Improved the deploy pipeline', action: 'Improved the deploy pipeline' };
  const recordId = await mkRecord(pg, userId, { type: 'experience-bullet', state: 'approved', source: 'manual', data });
  const asRecord = (over: Record<string, unknown> = {}) =>
    ({ id: recordId, userId, type: 'experience-bullet', source: 'manual', reviewState: 'approved', flaggedForRemoval: false, tags: [], contentHash: `h-${recordId}`, ...data, ...over }) as unknown as ProfileRecord;
  const signal: EnrichmentSignal = {
    rejectedRewrites: [{ recordId, text: data.text }],
    weakBullets: [],
    genuineGaps: [],
    document: null,
    job: null,
  };
  return { userId, roleId, recordId, asRecord, signal, roles: [role(roleId, userId)] };
}
const questions = (userId: string) => all<{ id: string; state: string; asked_count: number; answer: string; answer_record_id: string | null }>(pg, `select id, state, asked_count, answer, answer_record_id from enrichment_question where user_id=$1`, [userId]);

await suiteAsync('enrichment: recording', async () => {
  await testAsync('a question is recorded once, however many drafts raise it', async () => {
    const w = await world();
    assert.deepEqual(await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles), { added: 1, closed: 0 });
    assert.deepEqual(await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles), { added: 0, closed: 0 });
    assert.deepEqual(await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles), { added: 0, closed: 0 });
    const rows = await questions(w.userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].asked_count, 2, 'each re-raise counts as one more time it was put in front of the user');
  });

  await testAsync('questions are per user', async () => {
    const a = await world();
    const b = await world();
    await recordEnrichmentQuestions(a.userId, a.signal, [a.asRecord()], a.roles);
    assert.equal((await questions(b.userId)).length, 0);
  });

  await testAsync('mode off adds nothing, and the mode round-trips', async () => {
    const w = await world();
    assert.equal(await loadEnrichmentMode(w.userId), 'all');
    await setEnrichmentMode(w.userId, 'off');
    await setEnrichmentMode(w.userId, 'off');
    assert.equal(await loadEnrichmentMode(w.userId), 'off');
    assert.deepEqual(await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles), { added: 0, closed: 0 });
    assert.equal((await questions(w.userId)).length, 0);
    assert.deepEqual(await loadEnrichmentQueue(w.userId, [w.asRecord()]), { shown: [], total: 0, mode: 'off' });
  });

  await testAsync('a gap closed elsewhere takes its open question down on the next draft', async () => {
    const w = await world();
    await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles);
    const filled = w.asRecord({ scale: 'for 40 engineers', outcome: 'cut deploys from 40 to 8 minutes' });
    const r = await recordEnrichmentQuestions(w.userId, { ...w.signal, rejectedRewrites: [] }, [filled], w.roles);
    assert.deepEqual(r, { added: 0, closed: 1 });
    assert.equal((await questions(w.userId)).length, 0);
  });
});

await suiteAsync('enrichment: how many times it is shown', async () => {
  await testAsync('shown below MAX_TIMES_ASKED, hidden at it', async () => {
    const w = await world();
    await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles);
    await pg.query(`update enrichment_question set asked_count=$2 where user_id=$1`, [w.userId, MAX_TIMES_ASKED - 1]);
    assert.equal((await loadEnrichmentQueue(w.userId, [w.asRecord()])).total, 1);
    await pg.query(`update enrichment_question set asked_count=$2 where user_id=$1`, [w.userId, MAX_TIMES_ASKED]);
    const q = await loadEnrichmentQueue(w.userId, [w.asRecord()]);
    assert.equal(q.total, 0);
    assert.equal(q.shown.length, 0);
  });

  await testAsync('the queue shows the live missing parts of the line', async () => {
    const w = await world();
    await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles);
    const q = await loadEnrichmentQueue(w.userId, [w.asRecord()]);
    assert.equal(q.shown.length, 1);
    assert.equal(q.shown[0].recordId, w.recordId);
    assert.ok(q.shown[0].missing.length > 0);
  });
});

await suiteAsync('enrichment: settling', async () => {
  await testAsync('answering writes into the profile, closes the question, and it is never asked again', async () => {
    const w = await world();
    await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles);
    const [q] = await questions(w.userId);
    assert.equal(await answerEnrichmentQuestion(w.userId, q.id, { outcome: 'Cut deploy time by 80%' }), 'saved');
    const [after] = await questions(w.userId);
    assert.equal(after.state, 'answered');
    assert.equal(after.answer, 'Cut deploy time by 80%');
    assert.equal(after.answer_record_id, w.recordId);
    const row = await one<{ data: { outcome?: string; roleId: string; action: string }; source: string }>(pg, `select data, source from profile_record where id=$1`, [w.recordId]);
    assert.equal(row?.data.outcome, 'Cut deploy time by 80%');
    assert.equal(row?.data.roleId, w.roleId, 'the rest of the bullet is preserved');
    assert.equal(row?.source, 'manual');
    // Raised again by a later draft: the tombstone blocks it.
    assert.deepEqual(await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles), { added: 0, closed: 0 });
    assert.equal((await questions(w.userId)).length, 1);
    assert.equal((await loadEnrichmentQueue(w.userId, [w.asRecord()])).total, 0);
  });

  await testAsync('an answered question cannot be answered again', async () => {
    const w = await world();
    await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles);
    const [q] = await questions(w.userId);
    await answerEnrichmentQuestion(w.userId, q.id, { scale: 'for 30 engineers' });
    await assert.rejects(answerEnrichmentQuestion(w.userId, q.id, { scale: 'again' }), /already been dealt with/);
  });

  await testAsync('someone else\'s question cannot be answered', async () => {
    const a = await world();
    const b = await world();
    await recordEnrichmentQuestions(a.userId, a.signal, [a.asRecord()], a.roles);
    const [q] = await questions(a.userId);
    await assert.rejects(answerEnrichmentQuestion(b.userId, q.id, { scale: 'x' }), /already been dealt with/);
    assert.equal((await questions(a.userId))[0].state, 'open');
  });

  await testAsync('a bullet answer needs at least one of the two fields', async () => {
    const w = await world();
    await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles);
    const [q] = await questions(w.userId);
    await assert.rejects(answerEnrichmentQuestion(w.userId, q.id, {}), /at least one of the two/);
    assert.equal((await questions(w.userId))[0].state, 'open');
  });

  await testAsync('a refusal ("n/a") settles the question without touching the profile', async () => {
    const w = await world();
    await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles);
    const [q] = await questions(w.userId);
    assert.equal(await answerEnrichmentQuestion(w.userId, q.id, { outcome: 'n/a' }), 'declined');
    const [after] = await questions(w.userId);
    assert.equal(after.state, 'answered');
    assert.equal(after.answer_record_id, null);
    const row = await one<{ data: { outcome?: string } }>(pg, `select data from profile_record where id=$1`, [w.recordId]);
    assert.equal(row?.data.outcome, undefined);
  });

  await testAsync('skipping leaves a tombstone: not re-asked, and a second skip is a no-op', async () => {
    const w = await world();
    await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles);
    const [q] = await questions(w.userId);
    await dismissEnrichmentQuestion(w.userId, q.id);
    await dismissEnrichmentQuestion(w.userId, q.id);
    assert.equal((await questions(w.userId))[0].state, 'dismissed');
    assert.deepEqual(await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles), { added: 0, closed: 0 });
    assert.equal((await questions(w.userId)).length, 1);
    await dismissEnrichmentQuestion(w.userId, 'no-such-question');
  });

  await testAsync('deleting the record takes its question with it (foreign key cascade)', async () => {
    const w = await world();
    await recordEnrichmentQuestions(w.userId, w.signal, [w.asRecord()], w.roles);
    await pg.query(`delete from profile_record where id=$1`, [w.recordId]);
    assert.equal((await questions(w.userId)).length, 0);
  });
});

await t.close();
