/**
 * Coverage of lib/ under the test suite, with floors — `npm run test:coverage`.
 *
 * Why this is not `c8 npm test`: tsx loads the app's .ts files through `data:` URLs (see the
 * note in scripts/verify-radar-db.mts), and c8 cannot map a data: URL back to a source file —
 * it throws ERR_INVALID_URL_SCHEME while reporting. So this reads V8's raw coverage dumps
 * (NODE_V8_COVERAGE) itself.
 *
 * What the number is: the share of BYTES of each file's transpiled code that V8 saw execute
 * in at least one suite process, using block coverage (an `if` branch never taken counts as
 * not covered). Files no suite loads count as 0%. It is a byte measure, not a line measure,
 * and the transpiled code includes a small fixed preamble per file, so read it as a trend
 * and a floor rather than an exact figure. The floors sit three points below what was
 * measured when they were set; raise them when coverage rises, never lower one to get green.
 *
 *   node scripts/ci-coverage.mjs            run the suite under coverage, enforce the floors
 *   node scripts/ci-coverage.mjs --report   print the table, enforce nothing
 *   node scripts/ci-coverage.mjs --from DIR reuse an existing NODE_V8_COVERAGE directory
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Percent floors by group. Measured, then set 3 points lower — see the header. */
const FLOORS = {
  // measured 2026-10-08 (Windows, Node 20): auth 82.6, serp 80.7, radar 72.8, server 44.6, overall 72.0
  'lib/auth': 79,
  'lib/serp': 77,
  'lib/radar': 69,
  'lib/server': 41,
  'lib (overall)': 69,
};

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const fromIdx = args.indexOf('--from');
let dir = fromIdx >= 0 ? args[fromIdx + 1] : '';
const made = !dir;

if (!dir) {
  dir = mkdtempSync(join(tmpdir(), 'resumer-v8cov-'));
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const run = spawnSync(
    process.execPath,
    [tsxCli, '--tsconfig', join(root, 'scripts', 'tsconfig.json'), join(root, 'tests', 'run.mts')],
    { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: dir } },
  );
  if (run.status !== 0) {
    console.error('\nThe test suite failed, so coverage is not meaningful. Fix the tests first.');
    process.exit(run.status ?? 1);
  }
}

/** repo-relative posix path for a script URL, or null when it is not one of ours. */
function repoPath(url) {
  let file;
  if (url.startsWith('data:')) {
    const m = url.match(/\?filePath=(.*)$/);
    if (!m) return null;
    file = decodeURIComponent(m[1]);
  } else if (url.startsWith('file:')) {
    file = fileURLToPath(url);
  } else return null;
  const rel = relative(root, file).split(sep).join('/');
  return rel.startsWith('lib/') && /\.(ts|tsx)$/.test(rel) ? rel : null;
}

/** file -> best covered fraction seen in any process / any transform of that file. */
const best = new Map();
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
  let dump;
  try {
    dump = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch {
    continue;
  }
  for (const script of dump.result ?? []) {
    const file = repoPath(script.url);
    if (!file) continue;
    // functions[0] is the script itself, whose range spans the whole file INCLUDING the inline
    // source map tsx appends (tens of kilobytes of base64 that always counts as run). Measure
    // up to the end of the last real function instead.
    const ranges = script.functions.flatMap((fn) => fn.ranges);
    const len = Math.max(0, ...script.functions.slice(1).flatMap((fn) => fn.ranges).map((r) => r.endOffset));
    if (!len) continue;
    // Later (nested) ranges override earlier ones: apply outermost first.
    const bits = new Uint8Array(len);
    ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    for (const r of ranges) bits.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, len));
    let hit = 0;
    for (const b of bits) hit += b;
    const frac = hit / len;
    if (frac > (best.get(file) ?? -1)) best.set(file, frac);
  }
}

// Generated, not written: 2.5 MB of embedded font bytes would swamp every figure that includes it.
const GENERATED = /lib\/render\/fonts\/data\.ts$/;

function walk(d, out = []) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') && !GENERATED.test(p.split(sep).join('/'))) out.push(p);
  }
  return out;
}

const files = walk(join(root, 'lib')).map((p) => ({
  file: relative(root, p).split(sep).join('/'),
  size: statSync(p).size,
}));

const groups = {
  'lib/auth': (f) => f.startsWith('lib/auth/'),
  'lib/serp': (f) => f.startsWith('lib/serp/'),
  'lib/radar': (f) => f.startsWith('lib/radar/'),
  'lib/server': (f) => f.startsWith('lib/server/'),
  'lib (overall)': () => true,
};

const rows = Object.entries(groups).map(([name, test]) => {
  const inGroup = files.filter((f) => test(f.file));
  const total = inGroup.reduce((n, f) => n + f.size, 0);
  const covered = inGroup.reduce((n, f) => n + f.size * (best.get(f.file) ?? 0), 0);
  return { name, files: inGroup.length, loaded: inGroup.filter((f) => best.has(f.file)).length, pct: total ? (100 * covered) / total : 0 };
});

console.log('\nCoverage of lib/ (byte-weighted, block coverage; see scripts/ci-coverage.mjs)');
console.log('group'.padEnd(16), 'files'.padStart(6), 'loaded'.padStart(7), 'covered'.padStart(9), 'floor'.padStart(7));
let failed = false;
for (const r of rows) {
  const floor = FLOORS[r.name] ?? 0;
  const bad = r.pct < floor;
  failed ||= bad;
  console.log(r.name.padEnd(16), String(r.files).padStart(6), String(r.loaded).padStart(7), `${r.pct.toFixed(1)}%`.padStart(9), `${floor}%`.padStart(7), bad ? '  BELOW FLOOR' : '');
}

if (made) rmSync(dir, { recursive: true, force: true });
if (!reportOnly && failed) {
  console.error('\nCoverage fell below a floor. Add tests; do not lower the floor.');
  process.exit(1);
}
