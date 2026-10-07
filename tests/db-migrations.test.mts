/**
 * Versioned migrations: the migration folder must always produce the same database as the live
 * Drizzle schema (a schema change without `npm run db:generate` fails here), and the helpers that
 * mark an already-pushed database as at baseline must hash and order exactly like drizzle-orm's
 * migrator does.
 */
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { createTestDb } from './db/pg.mjs';
import { baselineRows, migrationHash, pendingMigrations, readJournal } from '../lib/db/migrations';

const FOLDER = 'drizzle';

async function shape(pg: PGlite): Promise<string[]> {
  const cols = await pg.query<{ s: string }>(`
    select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' ||
           coalesce(column_default, '') as s
    from information_schema.columns where table_schema = 'public' order by 1`);
  const idx = await pg.query<{ s: string }>(`
    select 'index ' || indexname as s from pg_indexes where schemaname = 'public' order by 1`);
  const con = await pg.query<{ s: string }>(`
    select 'constraint ' || conrelid::regclass::text || '.' || conname || ':' || contype::text as s
    from pg_constraint where connamespace = 'public'::regnamespace order by 1`);
  // drizzle-kit names the columns' NOT NULL constraints on newer Postgres versions; they are
  // covered by is_nullable above, so keep the comparison to the structural ones.
  return [...cols.rows, ...idx.rows, ...con.rows].map((r) => r.s).filter((s) => !/_not_null:n$/.test(s));
}

await suiteAsync('migrations match the live schema', async () => {
  await testAsync('the whole journal, applied in order, equals the Drizzle schema', async () => {
    const live = await createTestDb();
    const fresh = new PGlite();
    for (const e of readJournal(FOLDER)) {
      const text = readFileSync(`${FOLDER}/${e.tag}.sql`, 'utf8');
      for (const stmt of text.split('--> statement-breakpoint')) if (stmt.trim()) await fresh.exec(stmt);
    }
    const a = await shape(live.pg);
    const b = await shape(fresh);
    const onlyLive = a.filter((x) => !b.includes(x));
    const onlyMigrated = b.filter((x) => !a.includes(x));
    assert(
      onlyLive.length === 0 && onlyMigrated.length === 0,
      `schema drift: run npm run db:generate.\n  only in schema.ts: ${onlyLive.slice(0, 5).join(' | ')}\n  only in migrations: ${onlyMigrated.slice(0, 5).join(' | ')}`,
    );
    assert(a.length > 100, 'the comparison looked at a real schema');
    await live.close();
    await fresh.close();
  });
});

await suiteAsync('baseline marking', async () => {
  await testAsync('journal entries are ordered and have increasing timestamps', async () => {
    const j = readJournal(FOLDER);
    assert(j.length >= 1 && j[0].tag === '0000_baseline', 'baseline is first');
    for (let i = 1; i < j.length; i++) assert(j[i].when > j[i - 1].when, 'timestamps increase');
  });

  await testAsync('the hash is the SHA-256 of the file text, as drizzle-orm computes it', async () => {
    const text = readFileSync(`${FOLDER}/0000_baseline.sql`, 'utf8');
    assert(migrationHash(text) === createHash('sha256').update(text).digest('hex'), 'same digest');
    const [row] = baselineRows(FOLDER);
    assert(row.tag === '0000_baseline' && row.hash === migrationHash(text), 'row carries the file hash');
    assert(row.createdAt === readJournal(FOLDER)[0].when, 'created_at is the journal timestamp');
  });

  await testAsync('baseline marks only up to the named migration and rejects unknown names', async () => {
    assert(baselineRows(FOLDER).length === 1, 'default marks only the first');
    let threw = false;
    try {
      baselineRows(FOLDER, '9999_nope');
    } catch {
      threw = true;
    }
    assert(threw, 'an unknown tag is refused');
  });

  await testAsync('pending migrations are those newer than the newest applied', async () => {
    const entries = [
      { idx: 0, tag: 'a', when: 100 },
      { idx: 1, tag: 'b', when: 200 },
      { idx: 2, tag: 'c', when: 300 },
    ];
    assert(pendingMigrations(entries, null).length === 3, 'nothing applied: all pending');
    assert(pendingMigrations(entries, 100).map((e) => e.tag).join() === 'b,c', 'after the first');
    assert(pendingMigrations(entries, 300).length === 0, 'up to date');
  });
});
