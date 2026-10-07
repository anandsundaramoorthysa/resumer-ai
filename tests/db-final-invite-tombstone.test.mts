/**
 * Invite quota tombstone (scripts/2026-10-08-invite-tombstone.sql) on PGlite.
 * Named db-* so the runner gives it the PGlite tsconfig. Nothing here touches Neon.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { mkUser, one } from './db/seed.mjs';
import { istDayStart } from '../lib/time/ist';

const MIGRATION = readFileSync(new URL('../scripts/2026-10-08-invite-tombstone.sql', import.meta.url), 'utf8');
const OLD_SCHEMA = readFileSync(new URL('../scripts/2026-10-07-consent-invites.sql', import.meta.url), 'utf8');

async function shape(pg: PGlite) {
  const col = await pg.query<{ attnotnull: boolean }>(
    `select attnotnull from pg_attribute where attrelid = 'public.invite_redemption'::regclass and attname = 'user_id'`,
  );
  const fks = await pg.query<{ confdeltype: string; target: string }>(
    `select confdeltype, confrelid::regclass::text as target from pg_constraint
     where conrelid = 'public.invite_redemption'::regclass and contype = 'f' and conkey = array[(select attnum from pg_attribute where attrelid = 'public.invite_redemption'::regclass and attname = 'user_id')]`,
  );
  const uniq = await pg.query<{ n: number }>(
    `select count(*)::int as n from pg_constraint where conrelid = 'public.invite_redemption'::regclass and contype = 'u'`,
  );
  return { notNull: col.rows[0]?.attnotnull, fks: fks.rows, unique: uniq.rows[0]?.n };
}

const t = await installTestDb();

await suiteAsync('invite tombstone: migration matches the Drizzle schema', async () => {
  const legacy = new PGlite();
  await legacy.exec(`create table "user" (id text primary key);`);
  // The legacy script's own user reference needs only this table; run just its invite tables.
  const inviteDdl = OLD_SCHEMA.slice(OLD_SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS "invite_code"'));
  await legacy.exec(inviteDdl);
  const before = await shape(legacy);
  await testAsync('legacy table is NOT NULL + CASCADE', async () => {
    assert.equal(before.notNull, true);
    assert.equal(before.fks[0]?.confdeltype, 'c');
  });
  await legacy.exec(MIGRATION);
  const once = await shape(legacy);
  await legacy.exec(MIGRATION);
  const twice = await shape(legacy);
  const drizzle = await shape(t.pg);
  await testAsync('migration result equals the Drizzle-generated schema', async () => {
    assert.equal(once.notNull, false);
    assert.deepEqual(once, drizzle);
  });
  await testAsync('a second run is a no-op', async () => {
    assert.deepEqual(twice, once);
    assert.equal(twice.fks.length, 1);
  });
  await legacy.close();
});

await suiteAsync('invite tombstone: deleting the account keeps the quota row', async () => {
  const a = await mkUser(t.pg, 'inv-a', { approval: 'approved' });
  await mkUser(t.pg, 'inv-b', { approval: 'approved' });
  await t.pg.query(`insert into invite_redemption (id, user_id, redeemed_at) values ('r1', $1, now()), ('r2', 'inv-b', now())`, [a]);
  const since = istDayStart(new Date());
  const count = async () => (await one<{ n: number }>(t.pg, `select count(*)::int as n from invite_redemption where redeemed_at >= $1`, [since]))!.n;

  await testAsync('count before delete', async () => assert.equal(await count(), 2));
  await t.pg.query(`delete from "user" where id = $1`, [a]);
  await testAsync('after delete the row remains, user_id null, still counted', async () => {
    assert.equal(await count(), 2);
    const row = await one<{ user_id: string | null }>(t.pg, `select user_id from invite_redemption where id = 'r1'`);
    assert.equal(row?.user_id, null);
  });
  await testAsync('tombstones do not collide on the unique user_id (many NULLs)', async () => {
    await mkUser(t.pg, 'inv-c', { approval: 'approved' });
    await t.pg.query(`insert into invite_redemption (id, user_id) values ('r3', 'inv-c')`);
    await t.pg.query(`delete from "user" where id = 'inv-c'`);
    assert.equal(await count(), 3);
  });
  await testAsync('a user cannot hold two live redemptions', async () => {
    await assert.rejects(t.pg.query(`insert into invite_redemption (id, user_id) values ('r4', 'inv-b')`));
  });
});
