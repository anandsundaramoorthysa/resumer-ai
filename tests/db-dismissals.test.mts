/**
 * lib/server/dismissals.ts against a real Postgres engine: one mark per fact, restore keeps
 * the id and approves, a bullet cannot come back under a job that is still removed.
 */
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { all, mkUser, one } from './db/seed.mjs';
import {
  dismissRecordRow,
  dismissRoleRow,
  dismissalKeysFor,
  forgetDismissal,
  forgetDismissalFor,
  listDismissed,
  loadDismissals,
  restoreDismissal,
} from '../lib/server/dismissals';

const t = await installTestDb();
const { pg } = t;

type Row = Parameters<typeof dismissRecordRow>[1];
type RoleRow = Parameters<typeof dismissRoleRow>[1];
const recordRow = (id: string, hash: string, data: Record<string, unknown>, type = 'skill'): Row =>
  ({ id, userId: 'x', type, source: 'github-sync', contentHash: hash, tags: ['t'], data, flaggedForRemoval: false, reviewState: 'approved', createdAt: new Date(), updatedAt: new Date() }) as Row;
const roleRow = (id: string, title: string, company: string): RoleRow =>
  ({ id, userId: 'x', title, company, location: null, startDate: '2020-01', endDate: '2022-01', source: 'github-sync', contentHash: `rh-${id}`, reviewState: 'approved', createdAt: new Date() }) as RoleRow;

const u = await mkUser(pg);
const other = await mkUser(pg);

await suiteAsync('dismissals: one mark per fact', async () => {
  await testAsync('dismissing the same hash twice leaves one row, with the newest snapshot', async () => {
    await dismissRecordRow(u, recordRow('r1', 'hash-dup', { name: 'Docker', category: 'tool' }));
    await dismissRecordRow(u, recordRow('r1b', 'hash-dup', { name: 'Docker Compose', category: 'tool' }));
    const rows = await all<{ label: string; snapshot: { id: string } }>(pg, `select label, snapshot from dismissed_record where user_id=$1 and content_hash='hash-dup'`, [u]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'Docker Compose');
    assert.equal(rows[0].snapshot.id, 'r1b');
  });

  await testAsync('the mark is per user: the same hash for another user is its own row', async () => {
    await dismissRecordRow(other, recordRow('r9', 'hash-dup', { name: 'Docker', category: 'tool' }));
    assert.equal((await loadDismissals(u)).filter((d) => d.contentHash === 'hash-dup').length, 1);
    assert.equal((await loadDismissals(other)).filter((d) => d.contentHash === 'hash-dup').length, 1);
    assert.equal((await listDismissed(other)).length, 1);
  });

  await testAsync('a summary is blocked by fingerprint only (no identity key)', async () => {
    await dismissRecordRow(u, recordRow('s1', 'hash-sum', { text: 'A sentence.' }, 'summary'));
    const d = (await loadDismissals(u)).find((x) => x.contentHash === 'hash-sum');
    assert.equal(d?.identityKey, null);
    assert.equal(dismissalKeysFor('summary', { text: 'x' }, 'h').identityKey, null);
  });

  await testAsync('a shape with no identity still blocks by fingerprint and does not throw', async () => {
    await dismissRecordRow(u, recordRow('w1', 'hash-weird', {}, 'no-such-type'));
    assert.ok((await loadDismissals(u)).some((x) => x.contentHash === 'hash-weird'));
  });

  await testAsync('label falls back through title/name/text, then the type', async () => {
    await dismissRecordRow(u, recordRow('l1', 'hash-l1', { text: '  hello  ' }, 'achievement'));
    await dismissRecordRow(u, recordRow('l2', 'hash-l2', {}, 'achievement'));
    const items = await listDismissed(u);
    assert.equal(items.find((i) => i.id && i.label === 'hello')?.type, 'achievement');
    assert.ok(items.some((i) => i.label === 'achievement'));
  });
});

await suiteAsync('dismissals: restore and forget', async () => {
  await testAsync('restore returns the row under its own id, approved, and clears the mark', async () => {
    await dismissRecordRow(u, recordRow('keep-id', 'hash-keep', { name: 'Redis', category: 'tool' }));
    const mark = await one<{ id: string }>(pg, `select id from dismissed_record where user_id=$1 and content_hash='hash-keep'`, [u]);
    const label = await restoreDismissal(u, mark!.id);
    assert.equal(label, 'Redis');
    const rec = await one<{ id: string; review_state: string; flagged_for_removal: boolean; source: string }>(pg, `select id, review_state, flagged_for_removal, source from profile_record where id='keep-id'`);
    assert.equal(rec?.review_state, 'approved');
    assert.equal(rec?.flagged_for_removal, false);
    assert.equal(rec?.source, 'github-sync');
    assert.equal(await one(pg, `select 1 from dismissed_record where id=$1`, [mark!.id]), undefined);
    assert.equal((await one<{ n: number }>(pg, `select count(*)::int n from audit_log where user_id=$1 and action='dismissal-restore'`, [u]))?.n, 1);
  });

  await testAsync('restoring a mark that is gone, or someone else\'s, throws and writes nothing', async () => {
    await dismissRecordRow(other, recordRow('theirs', 'hash-theirs', { name: 'Go', category: 'language' }));
    const mark = await one<{ id: string }>(pg, `select id from dismissed_record where user_id=$1 and content_hash='hash-theirs'`, [other]);
    await assert.rejects(restoreDismissal(u, mark!.id), /no longer on this list/);
    await assert.rejects(restoreDismissal(u, 'nope'), /no longer on this list/);
    assert.equal(await one(pg, `select 1 from profile_record where id='theirs'`), undefined);
  });

  await testAsync('a bullet cannot come back under a job that is still removed; both order correctly', async () => {
    await dismissRoleRow(u, roleRow('job-1', 'Staff Engineer', 'Initech'));
    await dismissRecordRow(u, recordRow('b-1', 'hash-b1', { roleId: 'job-1', text: 'Shipped X', action: 'Shipped X' }, 'experience-bullet'));
    const jobMark = await one<{ id: string }>(pg, `select id from dismissed_record where user_id=$1 and kind='role'`, [u]);
    const bulletMark = await one<{ id: string }>(pg, `select id from dismissed_record where user_id=$1 and content_hash='hash-b1'`, [u]);
    await assert.rejects(restoreDismissal(u, bulletMark!.id), /Bring the job back first/);
    assert.equal(await one(pg, `select 1 from profile_record where id='b-1'`), undefined, 'refused: nothing stored');
    assert.ok(await one(pg, `select 1 from dismissed_record where id=$1`, [bulletMark!.id]), 'the mark stays');

    assert.equal(await restoreDismissal(u, jobMark!.id), 'Staff Engineer — Initech');
    const job = await one<{ id: string; review_state: string; end_date: string }>(pg, `select id, review_state, end_date from role where id='job-1'`);
    assert.equal(job?.review_state, 'approved');
    assert.equal(job?.end_date, '2022-01');
    // The line that was removed with the job comes back with it.
    assert.ok(await one(pg, `select 1 from profile_record where id='b-1'`));
    assert.equal(await one(pg, `select 1 from dismissed_record where id=$1`, [bulletMark!.id]), undefined);
  });

  await testAsync('restoring a job brings back the lines removed with it, not ones removed earlier', async () => {
    await dismissRecordRow(u, recordRow('b-early', 'hash-early', { roleId: 'job-2', text: 'Removed on its own', action: 'x' }, 'experience-bullet'));
    await new Promise((r) => setTimeout(r, 15));
    await dismissRoleRow(u, roleRow('job-2', 'Engineer', 'Globex'));
    await dismissRecordRow(u, recordRow('b-with', 'hash-with', { roleId: 'job-2', text: 'Removed with the job', action: 'x' }, 'experience-bullet'));
    await dismissRecordRow(u, recordRow('b-else', 'hash-else', { roleId: 'job-3', text: 'Another job', action: 'x' }, 'experience-bullet'));
    const jobMark = await one<{ id: string }>(pg, `select id from dismissed_record where user_id=$1 and content_hash='rh-job-2'`, [u]);
    await restoreDismissal(u, jobMark!.id);
    assert.ok(await one(pg, `select 1 from profile_record where id='b-with' and review_state='approved'`));
    assert.equal(await one(pg, `select 1 from profile_record where id='b-early'`), undefined, 'an earlier, individual removal stays removed');
    assert.equal(await one(pg, `select 1 from profile_record where id='b-else'`), undefined, 'another job\'s line is untouched');
    assert.ok(await one(pg, `select 1 from dismissed_record where user_id=$1 and content_hash='hash-early'`, [u]));
  });

  await testAsync('a job that belongs to someone else does not satisfy the bullet\'s parent check', async () => {
    await pg.query(`insert into role (id,user_id,title,company,start_date,source,content_hash) values ('job-other',$1,'T','C','2020-01','manual','x')`, [other]);
    await dismissRecordRow(u, recordRow('b-2', 'hash-b2', { roleId: 'job-other', text: 'x' }, 'experience-bullet'));
    const m = await one<{ id: string }>(pg, `select id from dismissed_record where user_id=$1 and content_hash='hash-b2'`, [u]);
    await assert.rejects(restoreDismissal(u, m!.id), /Bring the job back first/);
  });

  await testAsync('forgetDismissal lifts the block and restores nothing; unknown id throws', async () => {
    await dismissRecordRow(u, recordRow('f-1', 'hash-f1', { name: 'Kafka', category: 'tool' }));
    const m = await one<{ id: string }>(pg, `select id from dismissed_record where user_id=$1 and content_hash='hash-f1'`, [u]);
    assert.equal(await forgetDismissal(u, m!.id), 'Kafka');
    assert.equal(await one(pg, `select 1 from dismissed_record where id=$1`, [m!.id]), undefined);
    assert.equal(await one(pg, `select 1 from profile_record where id='f-1'`), undefined);
    await assert.rejects(forgetDismissal(u, m!.id), /no longer on this list/);
  });

  await testAsync('forgetDismissal cannot remove another user\'s mark', async () => {
    const m = await one<{ id: string }>(pg, `select id from dismissed_record where user_id=$1 limit 1`, [other]);
    await assert.rejects(forgetDismissal(u, m!.id), /no longer on this list/);
    assert.ok(await one(pg, `select 1 from dismissed_record where id=$1`, [m!.id]));
  });

  await testAsync('forgetDismissalFor lifts by fingerprint, and by identity when given one', async () => {
    await dismissRecordRow(u, recordRow('g-1', 'hash-g1', { name: 'Rust', category: 'language' }));
    await dismissRecordRow(u, recordRow('g-2', 'hash-g2', { name: 'Elixir', category: 'language' }));
    const keys2 = dismissalKeysFor('skill', { name: 'Elixir', category: 'language' }, 'a-different-hash');
    assert.ok(keys2.identityKey);
    await forgetDismissalFor(u, { contentHash: 'hash-g1' });
    await forgetDismissalFor(u, keys2);
    const left = (await loadDismissals(u)).map((d) => d.contentHash);
    assert.ok(!left.includes('hash-g1'));
    assert.ok(!left.includes('hash-g2'), 'the retyped fact (different hash, same identity) lifts the block');
    assert.ok(left.includes('hash-sum'), 'unrelated marks stay');
    assert.ok((await loadDismissals(other)).some((d) => d.contentHash === 'hash-dup'), 'other users are untouched');
  });
});

await t.close();
