/**
 * PDF reading must work on a host with no native canvas binary — the regression nothing
 * else would catch.
 *
 * WHAT BROKE, AND WHY EVERY LOCAL TEST STILL PASSED
 *
 * Every PDF upload and every PDF job description was refused in production, with a
 * message telling the user their file was probably a scan. Two causes, neither of which
 * can appear on a developer machine:
 *
 *   1. `ReferenceError: DOMMatrix is not defined`. pdfjs evaluates `new DOMMatrix()` at
 *      module load and borrows one from `@napi-rs/canvas`. That package's platform binary
 *      is installed locally by `npm i` and is absent from the function bundle, because it
 *      is picked with a platform-dependent require that build-time tracing cannot follow.
 *      Fixed by lib/render/dommatrix.ts.
 *   2. `Setting up fake worker failed: Cannot find module …/pdf.worker.mjs`. pdfjs loads
 *      its worker by absolute path, so nothing referenced the file statically and it was
 *      never bundled. Fixed by the literal worker import in lib/render/selftest.ts.
 *
 * Both fixes are invisible locally: the machine running the tests HAS the binary, so the
 * broken code and the fixed code behave identically. This harness removes that
 * difference. It re-spawns itself with scripts/no-canvas-preload.cjs, which makes
 * `@napi-rs/canvas` and its platform binaries unresolvable, and then asserts that a real
 * PDF still comes back as text.
 *
 * Exits non-zero when extraction fails, so CI catches a regression in either fix.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/verify-pdf-without-canvas.mts
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const preload = join(here, 'no-canvas-preload.cjs');

/** A few hundred bytes, committed, with a real text layer. Nothing outside the repo. */
const FIXTURE = join(root, 'tests', 'fixtures', 'text-layer.pdf');

/** Strings that must survive the round trip, from the fixture's content stream. */
const MUST_CONTAIN = [
  'Resumer AI PDF fixture',
  'priya@example.com',
  'Cut p95 checkout latency from 840ms to 210ms',
];

const CHILD_FLAG = 'RESUMER_NO_CANVAS';

if (process.env[CHILD_FLAG] !== '1') {
  respawnUnderPreload();
} else {
  await verify();
}

/**
 * The preload has to be in place before the first import of pdfjs, and this file's own
 * imports have already run by the time it could install one — hence a second process
 * rather than a clever import order.
 *
 * The flag goes through NODE_OPTIONS as well as on the command line: `tsx` may run the
 * script in a child of its own, and NODE_OPTIONS is what survives that.
 */
function respawnUnderPreload(): void {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const requireFlag = `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}`;

  console.log('verify-pdf-without-canvas: re-spawning with @napi-rs/canvas blocked\n');

  const result = spawnSync(
    process.execPath,
    [
      '--require',
      preload,
      tsxCli,
      '--tsconfig',
      join(root, 'scripts', 'tsconfig.json'),
      fileURLToPath(import.meta.url),
    ],
    {
      stdio: 'inherit',
      cwd: root,
      env: {
        ...process.env,
        [CHILD_FLAG]: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${requireFlag}`.trim(),
      },
    },
  );

  process.exit(result.status ?? 1);
}

async function verify(): Promise<void> {
  const failures: string[] = [];
  const check = (ok: boolean, label: string, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(label);
  };

  // --- 1. the host condition is actually reproduced --------------------------
  //
  // Asserted first, and treated as a failure rather than a skip. A harness that quietly
  // ran with the binary present would report a pass for precisely the configuration that
  // never had the bug — which is the situation this file exists to end.
  console.log('the host condition');
  const req = createRequire(import.meta.url);
  check(
    (globalThis as { __resumerNoCanvasPreload?: boolean }).__resumerNoCanvasPreload === true,
    'the preload is installed in this process',
  );
  check(canvasIsUnavailable(req), '@napi-rs/canvas cannot be loaded');
  check(
    canvasIsUnavailable(req, '@napi-rs/canvas-win32-x64-msvc') &&
      canvasIsUnavailable(req, '@napi-rs/canvas-linux-x64-gnu') &&
      canvasIsUnavailable(req, '@napi-rs/canvas-darwin-arm64'),
    'its platform binaries cannot be loaded either',
  );
  check(
    typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix !== 'function',
    'the runtime has no DOMMatrix of its own',
  );

  // --- 2. each fix, named, under that condition ------------------------------
  //
  // Checked one by one as well as end to end. Text extraction happens to survive a
  // missing DOMMatrix in the pdfjs version currently pinned — the crash is on the canvas
  // display path — so an extraction that passes is NOT on its own evidence that the
  // polyfill is still there. The next pdfjs bump can move that line, and the deploy
  // target has no canvas either way.
  console.log('\nthe fixes under that condition');
  const { ensureDOMMatrix } = await import('../lib/render/dommatrix');
  check(ensureDOMMatrix() === 'polyfilled', 'lib/render/dommatrix.ts supplies a DOMMatrix');
  check(await workerLoads(), 'pdfjs’s worker file is where lib/render/selftest.ts names it');

  // --- 3. and a PDF still extracts -------------------------------------------
  const bytes = readFileSync(FIXTURE);
  check(bytes.length > 0, `fixture read (${bytes.length} bytes)`);

  let text = '';
  try {
    const { extractTextFromPdf } = await import('../lib/render/selftest');
    text = await extractTextFromPdf(bytes);
  } catch (err) {
    check(false, 'extractTextFromPdf', err instanceof Error ? err.message : String(err));
  }

  const flat = text.replace(/\s+/g, ' ').trim();
  check(flat.length > 0, `text extracted (${flat.length} chars)`);
  for (const wanted of MUST_CONTAIN) {
    check(flat.includes(wanted), `extracted text contains "${wanted}"`);
  }

  console.log('');
  if (failures.length > 0) {
    console.error(
      `FAILED (${failures.length}): ${failures.join('; ')}\n` +
        'PDF reading is broken on a host with no native canvas binary — which is every ' +
        'deploy target this app has. See lib/render/dommatrix.ts and the worker import ' +
        'in lib/render/selftest.ts.',
    );
    process.exit(1);
  }
  console.log('PDF extraction works with no native canvas binary.');
}

/**
 * The literal specifier from lib/render/selftest.ts, which is what pulls the worker into
 * the deployed bundle. It went missing once already — every PDF failed with "Setting up
 * fake worker failed: Cannot find module …/pdf.worker.mjs" — and a rename here is
 * invisible until a deploy.
 */
async function workerLoads(): Promise<boolean> {
  try {
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the specifier cannot be loaded at all — the host's condition.
 *
 * A real `require`, not `require.resolve`. Requiring is what pdfjs does, and it is the
 * only question that has a single answer: tsx installs its own CJS resolver and will
 * answer `require.resolve` for an `exports`-mapped package without consulting the block,
 * so a resolve-only check reports a condition that was never created.
 */
function canvasIsUnavailable(req: NodeRequire, specifier = '@napi-rs/canvas'): boolean {
  try {
    req(specifier);
    return false;
  } catch {
    return true;
  }
}
