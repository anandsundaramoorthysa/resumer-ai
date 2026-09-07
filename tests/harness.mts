/**
 * The smallest thing that can be called a test runner.
 *
 * A framework is not earned here: these suites need grouping, an assertion, and a
 * non-zero exit code, and adding jest/vitest to a Next 16 + Tailwind 4 project means a
 * transform config to maintain for no capability the suites actually use.
 *
 * Run one suite:   npx tsx --tsconfig scripts/tsconfig.json tests/<file>.test.mts
 * Run all:         npm test
 */

import assert from 'node:assert/strict';

export { assert };

interface Failure {
  suite: string;
  name: string;
  message: string;
}

let currentSuite = '';
let passCount = 0;
const failures: Failure[] = [];

export function suite(name: string, body: () => void): void {
  currentSuite = name;
  console.log(`\n${name}`);
  body();
  currentSuite = '';
}

export function test(name: string, body: () => void): void {
  try {
    body();
    passCount += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ suite: currentSuite, name, message });
    console.log(`  FAIL ${name}`);
    console.log(`       ${message.split('\n')[0]}`);
  }
}

/**
 * Async sibling of `suite`. It exists so that `report()` cannot run before the tests
 * inside the group have finished — a sync `suite` wrapping `testAsync` calls returns
 * immediately and the file reports a pass count taken before anything was asserted.
 */
export async function suiteAsync(
  name: string,
  body: () => Promise<void>,
): Promise<void> {
  currentSuite = name;
  console.log(`\n${name}`);
  await body();
  currentSuite = '';
}

/** Async variant — awaited in order so output stays readable. */
export async function testAsync(
  name: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
    passCount += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ suite: currentSuite, name, message });
    console.log(`  FAIL ${name}`);
    console.log(`       ${message.split('\n')[0]}`);
  }
}

/**
 * The summary, emitted automatically when the suite process exits.
 *
 * This used to be a `report()` that each suite file had to remember to call at the end,
 * and **not one of the seventeen suites called it**. The consequence was not a missing
 * summary line — it was that `process.exitCode` was never set, every suite exited 0
 * whatever its assertions did, and `npm test` printed "All 17 suites passed" over a
 * deliberately failing assertion. Every green run was unverified.
 *
 * So it is no longer something a file can forget. `process.on('exit')` fires however the
 * suite ends, the handler is synchronous, and assigning `process.exitCode` from inside it
 * still determines the code the process returns.
 */
let summarised = false;

function summarise(): void {
  if (summarised) return;
  summarised = true;

  console.log('');
  if (failures.length === 0) {
    console.log(`${passCount} passed.`);
    return;
  }

  console.log(`${passCount} passed, ${failures.length} FAILED`);
  for (const f of failures) {
    console.log(`
  ${f.suite} — ${f.name}`);
    console.log(`  ${f.message}`);
  }
  process.exitCode = 1;
}

process.on('exit', summarise);

/**
 * An unhandled rejection must fail the suite too.
 *
 * A `testAsync` whose promise rejects outside the try — or a stray floating promise —
 * would otherwise print nothing and let the process exit 0, which is the same silent
 * pass this file exists to prevent.
 */
process.on('unhandledRejection', (reason) => {
  failures.push({
    suite: currentSuite || '(module scope)',
    name: 'unhandled rejection',
    message: reason instanceof Error ? reason.message : String(reason),
  });
  console.log(`  FAIL unhandled rejection`);
  process.exitCode = 1;
});

/**
 * Kept as a no-op for the suites that call it, and for anyone reading an old example.
 * The summary happens on exit now whether or not this is called.
 */
export function report(_label?: string): void {
  void _label;
}
