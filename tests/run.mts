/**
 * Runs every suite in this directory — `npm test`.
 *
 * Each suite runs in its own process rather than being imported into one. A suite that
 * crashes on import (a bad path, a module that will not load under tsx) then reports as
 * that suite failing, instead of taking the whole run down with it and hiding which one
 * broke.
 *
 * `db-*` suites run against an in-memory Postgres (PGlite, tests/db/). They are the slow
 * ones (a database to start each), so they run concurrently with each other and with the
 * rest, and their output is printed together at the end. Their tsconfig maps `@/lib/db` to a
 * stand-in client, so application modules run unchanged; the schema's DDL is generated once
 * here and handed to each of them.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const appConfig = join(root, 'scripts', 'tsconfig.json');
const dbConfig = join(here, 'db', 'tsconfig.json');

// TEST_FILTER=db- runs only the suites whose file name contains it.
const only = process.env.TEST_FILTER ?? '';
// TEST_SKIP=<regex> leaves out the suites it matches (used to measure coverage without a group).
const skip = process.env.TEST_SKIP ? new RegExp(process.env.TEST_SKIP) : null;
const all = readdirSync(here)
  .filter((f) => f.endsWith('.test.mts') && f.includes(only) && !(skip && skip.test(f)))
  .sort();
const dbSuites = all.filter((f) => f.startsWith('db-'));
const plainSuites = all.filter((f) => !f.startsWith('db-'));

const failed: string[] = [];
const started = Date.now();

/** Concurrency for the database suites: each is mostly waiting on a WASM Postgres. */
const DB_PARALLEL = Math.max(1, Math.min(4, Number(process.env.TEST_DB_PARALLEL ?? 4)));

const scratch = dbSuites.length ? mkdtempSync(join(tmpdir(), 'resumer-testdb-')) : '';
let dbEnv: NodeJS.ProcessEnv = process.env;
if (dbSuites.length) {
  const ddl = join(scratch, 'ddl.json');
  const built = spawnSync(process.execPath, [tsxCli, '--tsconfig', dbConfig, join(here, 'db', 'build-ddl.mts'), ddl], {
    stdio: 'inherit',
    cwd: root,
  });
  // On failure each suite generates its own, which is slower but still correct.
  if (built.status === 0) dbEnv = { ...process.env, TEST_DB_DDL_FILE: ddl };
}

function runDbSuite(suite: string): Promise<{ suite: string; code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, '--tsconfig', dbConfig, join(here, suite)], { cwd: root, env: dbEnv });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (out += d));
    child.on('close', (code) => resolve({ suite, code: code ?? 1, out }));
  });
}

async function runAllDb() {
  const results: Array<{ suite: string; code: number; out: string }> = [];
  const queue = [...dbSuites];
  await Promise.all(
    Array.from({ length: DB_PARALLEL }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) results.push(await runDbSuite(s));
    }),
  );
  return results.sort((a, b) => a.suite.localeCompare(b.suite));
}

const dbRun = runAllDb();

for (const suite of plainSuites) {
  console.log(`\n${'─'.repeat(64)}\n${suite}`);
  const result = spawnSync(process.execPath, [tsxCli, '--tsconfig', appConfig, join(here, suite)], {
    stdio: 'inherit',
    cwd: root,
  });
  if (result.status !== 0) failed.push(suite);
}

for (const r of await dbRun) {
  console.log(`\n${'─'.repeat(64)}\n${r.suite}  (in-memory Postgres)`);
  process.stdout.write(r.out);
  if (r.code !== 0) failed.push(r.suite);
}

if (scratch) rmSync(scratch, { recursive: true, force: true });

console.log(`\n${'─'.repeat(64)}`);
const seconds = Math.round((Date.now() - started) / 1000);
if (failed.length === 0) {
  console.log(`All ${all.length} suites passed in ${seconds}s.\n`);
} else {
  console.log(`${failed.length} of ${all.length} suites FAILED: ${failed.join(', ')}  (${seconds}s)\n`);
  process.exit(1);
}
