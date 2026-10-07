/** persistDraft is one transaction: a failing second write leaves no orphan snapshot. */
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { mkUser } from './db/seed.mjs';
import { persistDraft } from '../lib/server/profile';

const t = await installTestDb();
const { pg } = t;
const uid = await mkUser(pg, 'persist-1', { email: 'p1@example.test', approval: 'approved' });

const result = {
  document: { recordHashSnapshot: [], renderMode: 'ats-strict' },
  score: { overall: 8.6 },
  job: { roleTitle: 'Engineer', company: 'Acme', category: 'engineering' },
  files: { pdfName: 'X.pdf', docxName: 'X.docx', pdf: Buffer.alloc(0), docx: Buffer.alloc(0) },
} as never;

const count = async (table: string) =>
  Number(((await pg.query(`select count(*)::int n from "${table}"`)).rows[0] as { n: number }).n);

await suiteAsync('persistDraft atomicity', async () => {
  await testAsync('success writes the snapshot and its application together', async () => {
    const id = await persistDraft(uid, result);
    assert.equal(await count('resume_snapshot'), 1);
    assert.equal(await count('application'), 1);
    const r = await pg.query(`select resume_snapshot_id from application`);
    assert.equal((r.rows[0] as { resume_snapshot_id: string }).resume_snapshot_id, id);
  });

  await testAsync('a throwing application insert rolls the snapshot back', async () => {
    await pg.exec(`create function boom() returns trigger as $$ begin raise exception 'injected'; end $$ language plpgsql;
      create trigger boom_t before insert on application for each row execute function boom();`);
    await assert.rejects(() => persistDraft(uid, result), /injected|Failed query/);
    assert.equal(await count('resume_snapshot'), 1, 'no orphan snapshot');
    assert.equal(await count('application'), 1);
    await pg.exec(`drop trigger boom_t on application`);
  });
});
