/**
 * lib/server/sync-review.ts against a real Postgres engine: what approving and rejecting a
 * sync's proposals actually does to the rows.
 */
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { all, mkRecord, mkRole, mkUser, one } from './db/seed.mjs';
import {
  approveProposedRecords,
  approveProposedRoles,
  decideAllProposed,
  rejectProposedRecords,
  rejectProposedRoles,
} from '../lib/server/sync-review';

const t = await installTestDb();
const { pg } = t;
const rec = async (id: string) => one<{ review_state: string; source: string }>(pg, `select review_state, source from profile_record where id=$1`, [id]);
const role = async (id: string) => one<{ review_state: string }>(pg, `select review_state from role where id=$1`, [id]);
const bullet = (roleId: string) => ({ roleId, text: 'Cut latency', action: 'Cut latency' });

await suiteAsync('sync review: approve', async () => {
  await testAsync('approving keeps source=github-sync (agreeing with the parser is not overruling it)', async () => {
    const u = await mkUser(pg);
    const a = await mkRecord(pg, u);
    const r = await approveProposedRecords(u, [a]);
    assert.deepEqual(r, { records: 1, roles: 0 });
    assert.deepEqual(await rec(a), { review_state: 'approved', source: 'github-sync' });
  });

  await testAsync('an id that is not a proposal is a no-op (approved, rejected, or unknown)', async () => {
    const u = await mkUser(pg);
    const done = await mkRecord(pg, u, { state: 'approved' });
    const tomb = await mkRecord(pg, u, { state: 'rejected' });
    const r = await approveProposedRecords(u, [done, tomb, 'no-such-id']);
    assert.deepEqual(r, { records: 0, roles: 0 });
    assert.equal((await rec(tomb))?.review_state, 'rejected', 'approve must not un-reject');
    assert.equal((await rec(done))?.review_state, 'approved');
  });

  await testAsync('an empty list does nothing', async () => {
    const u = await mkUser(pg);
    assert.deepEqual(await approveProposedRecords(u, []), { records: 0, roles: 0 });
  });

  await testAsync('approving a bullet approves the pending role it hangs off', async () => {
    const u = await mkUser(pg);
    const r = await mkRole(pg, u);
    const b = await mkRecord(pg, u, { type: 'experience-bullet', data: bullet(r) });
    assert.deepEqual(await approveProposedRecords(u, [b]), { records: 1, roles: 1 });
    assert.equal((await role(r))?.review_state, 'approved');
  });

  await testAsync('approving a skill does not touch any role', async () => {
    const u = await mkUser(pg);
    const r = await mkRole(pg, u);
    const s = await mkRecord(pg, u);
    assert.deepEqual(await approveProposedRecords(u, [s]), { records: 1, roles: 0 });
    assert.equal((await role(r))?.review_state, 'pending');
  });

  await testAsync('cannot approve another user\'s proposal', async () => {
    const u = await mkUser(pg);
    const v = await mkUser(pg);
    const theirs = await mkRecord(pg, v);
    assert.deepEqual(await approveProposedRecords(u, [theirs]), { records: 0, roles: 0 });
    assert.equal((await rec(theirs))?.review_state, 'pending');
  });

  await testAsync('every decision is audited', async () => {
    const u = await mkUser(pg);
    const a = await mkRecord(pg, u);
    await approveProposedRecords(u, [a]);
    const log = await all<{ record_id: string; diff: { reviewState: string; decidedByUser: boolean } }>(pg, `select record_id, diff from audit_log where user_id=$1`, [u]);
    assert.equal(log.length, 1);
    assert.equal(log[0].record_id, a);
    assert.equal(log[0].diff.reviewState, 'approved');
    assert.equal(log[0].diff.decidedByUser, true);
  });
});

await suiteAsync('sync review: reject', async () => {
  await testAsync('rejecting leaves a rejected tombstone, not a deletion', async () => {
    const u = await mkUser(pg);
    const a = await mkRecord(pg, u);
    assert.deepEqual(await rejectProposedRecords(u, [a]), { records: 1, roles: 0 });
    assert.deepEqual(await rec(a), { review_state: 'rejected', source: 'github-sync' });
  });

  await testAsync('rejecting a record that is already approved changes nothing', async () => {
    const u = await mkUser(pg);
    const a = await mkRecord(pg, u, { state: 'approved' });
    assert.deepEqual(await rejectProposedRecords(u, [a, 'ghost']), { records: 0, roles: 0 });
    assert.equal((await rec(a))?.review_state, 'approved');
  });

  await testAsync('rejecting a bullet leaves its role alone', async () => {
    const u = await mkUser(pg);
    const r = await mkRole(pg, u);
    const b = await mkRecord(pg, u, { type: 'experience-bullet', data: bullet(r) });
    await rejectProposedRecords(u, [b]);
    assert.equal((await role(r))?.review_state, 'pending');
  });

  await testAsync('rejecting a role also rejects its pending bullets, and only its own', async () => {
    const u = await mkUser(pg);
    const r1 = await mkRole(pg, u);
    const r2 = await mkRole(pg, u);
    const b1 = await mkRecord(pg, u, { type: 'experience-bullet', data: bullet(r1) });
    const b1b = await mkRecord(pg, u, { type: 'experience-bullet', data: bullet(r1) });
    const b2 = await mkRecord(pg, u, { type: 'experience-bullet', data: bullet(r2) });
    const approvedB = await mkRecord(pg, u, { type: 'experience-bullet', state: 'approved', data: bullet(r1) });
    const out = await rejectProposedRoles(u, [r1]);
    assert.deepEqual(out, { records: 2, roles: 1 });
    assert.equal((await role(r1))?.review_state, 'rejected');
    assert.equal((await rec(b1))?.review_state, 'rejected');
    assert.equal((await rec(b1b))?.review_state, 'rejected');
    assert.equal((await rec(b2))?.review_state, 'pending', 'another job\'s bullet is untouched');
    assert.equal((await role(r2))?.review_state, 'pending');
    assert.equal((await rec(approvedB))?.review_state, 'approved', 'a settled bullet is not reopened');
  });

  await testAsync('rejecting an empty role list is a no-op', async () => {
    const u = await mkUser(pg);
    assert.deepEqual(await rejectProposedRoles(u, []), { records: 0, roles: 0 });
  });

  await testAsync('approving roles leaves their bullets for separate decision', async () => {
    const u = await mkUser(pg);
    const r = await mkRole(pg, u);
    const b = await mkRecord(pg, u, { type: 'experience-bullet', data: bullet(r) });
    assert.deepEqual(await approveProposedRoles(u, [r]), { records: 0, roles: 1 });
    assert.equal((await rec(b))?.review_state, 'pending');
    assert.deepEqual(await approveProposedRoles(u, [r]), { records: 0, roles: 0 }, 'second approve is a no-op');
  });
});

await suiteAsync('sync review: decide all', async () => {
  await testAsync('decides every pending row for this user and nobody else\'s', async () => {
    const u = await mkUser(pg);
    const v = await mkUser(pg);
    const r = await mkRole(pg, u);
    const a = await mkRecord(pg, u);
    const settled = await mkRecord(pg, u, { state: 'rejected' });
    const theirs = await mkRecord(pg, v);
    assert.deepEqual(await decideAllProposed(u, 'approved'), { records: 1, roles: 1 });
    assert.equal((await rec(a))?.review_state, 'approved');
    assert.equal((await role(r))?.review_state, 'approved');
    assert.equal((await rec(settled))?.review_state, 'rejected');
    assert.equal((await rec(theirs))?.review_state, 'pending');
    assert.deepEqual(await decideAllProposed(u, 'rejected'), { records: 0, roles: 0 });
  });
});

await t.close();
