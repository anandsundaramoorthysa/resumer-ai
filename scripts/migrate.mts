/**
 * Apply or inspect versioned migrations. Reads DATABASE_URL from .env like the other db scripts.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig scripts/tsconfig.json scripts/migrate.mts status
 *   ... migrate.mts up         apply every pending migration (fresh database, or after db:generate)
 *   ... migrate.mts baseline   mark an EXISTING database (built by db:push + scripts/*.sql) as
 *                              already at the baseline, without running it
 *
 * `baseline` refuses unless the database already has the app's tables and has no recorded
 * migrations: running it against an empty database would make `up` skip the whole baseline.
 * Both are safe to run twice. Nothing here prints the connection string.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { baselineRows, MIGRATIONS_FOLDER, pendingMigrations, readJournal } from '../lib/db/migrations';

const mode = process.argv[2];
const through = process.argv[3];
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Add it to .env first.');
if (!['status', 'up', 'baseline'].includes(mode ?? '')) {
  throw new Error('usage: migrate.mts <status|up|baseline> [baselineThroughTag]');
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20, onnotice: () => {} });

async function applied(): Promise<{ hash: string; created_at: string }[]> {
  const t = await sql`select to_regclass('drizzle.__drizzle_migrations') as t`;
  if (!t[0]?.t) return [];
  return sql<{ hash: string; created_at: string }[]>`
    select hash, created_at from drizzle."__drizzle_migrations" order by created_at asc`;
}

try {
  const rows = await applied();
  const newest = rows.length ? Number(rows[rows.length - 1].created_at) : null;
  const journal = readJournal(MIGRATIONS_FOLDER);

  if (mode === 'status') {
    console.log(`applied: ${rows.length} | in journal: ${journal.length}`);
    for (const e of pendingMigrations(journal, newest)) console.log(`pending: ${e.tag}`);
    if (pendingMigrations(journal, newest).length === 0) console.log('up to date');
  } else if (mode === 'up') {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
    const after = await applied();
    console.log(`migrated. applied: ${after.length} of ${journal.length}`);
  } else {
    const [user] = await sql`select to_regclass('public."user"') as t`;
    if (!user?.t) {
      throw new Error('Refusing to baseline: this database has no "user" table. Run `up` instead.');
    }
    if (rows.length > 0) {
      console.log(`already baselined (${rows.length} migration(s) recorded). Nothing to do.`);
    } else {
      const marks = baselineRows(MIGRATIONS_FOLDER, through);
      await sql.begin(async (tx) => {
        await tx.unsafe('create schema if not exists drizzle');
        await tx.unsafe(
          'create table if not exists drizzle."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)',
        );
        for (const m of marks) {
          await tx`insert into drizzle."__drizzle_migrations" (hash, created_at) values (${m.hash}, ${m.createdAt})`;
        }
      });
      console.log(`baselined through ${marks[marks.length - 1].tag} (${marks.length} migration(s) marked as applied).`);
    }
  }
} catch (e) {
  console.error('migrate failed:', String((e as Error).message).replace(/postgres(ql)?:\/\/\S+/g, '<url>'));
  process.exitCode = 1;
} finally {
  await sql.end();
}
