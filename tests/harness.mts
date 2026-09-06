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

/** Call at the end of a suite file. Exits non-zero if anything failed. */
export function report(label: string): void {
  console.log('');
  if (failures.length === 0) {
    console.log(`${label}: ${passCount} passed.`);
    return;
  }
  console.log(`${label}: ${passCount} passed, ${failures.length} FAILED`);
  for (const f of failures) {
    console.log(`\n  ${f.suite} — ${f.name}`);
    console.log(`  ${f.message}`);
  }
  process.exitCode = 1;
}
