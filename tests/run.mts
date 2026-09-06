/**
 * Runs every suite in this directory — `npm test`.
 *
 * Each suite runs in its own process rather than being imported into one. A suite that
 * crashes on import (a bad path, a module that will not load under tsx) then reports as
 * that suite failing, instead of taking the whole run down with it and hiding which one
 * broke.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const suites = readdirSync(here)
  .filter((f) => f.endsWith('.test.mts'))
  .sort();

const failed: string[] = [];

for (const suite of suites) {
  console.log(`\n${'─'.repeat(64)}\n${suite}`);
  const result = spawnSync(
    process.execPath,
    [tsxCli, '--tsconfig', join(root, 'scripts', 'tsconfig.json'), join(here, suite)],
    { stdio: 'inherit', cwd: root },
  );
  if (result.status !== 0) failed.push(suite);
}

console.log(`\n${'─'.repeat(64)}`);
if (failed.length === 0) {
  console.log(`All ${suites.length} suites passed.\n`);
} else {
  console.log(`${failed.length} of ${suites.length} suites FAILED: ${failed.join(', ')}\n`);
  process.exit(1);
}
