/**
 * Makes `@napi-rs/canvas` unresolvable, the way Netlify's Lambda has it.
 *
 * This is the whole difference between the developer machine and the host, and it is why
 * PDF reading was broken in production while every local test passed. `npm i` puts a
 * platform binary (`@napi-rs/canvas-win32-x64-msvc`, `-linux-x64-gnu`, …) next to the
 * package on a real machine; the function bundle has neither, because the package picks
 * its binary with a platform-dependent require that build-time file tracing cannot
 * follow. pdfjs then fails to borrow a DOMMatrix from it, warns, and dies one line later
 * — see lib/render/dommatrix.ts.
 *
 * Loaded with `--require` in front of the harness, so the block is in place before
 * anything imports pdfjs. It is how the bug was originally diagnosed.
 *
 * The CJS resolver is the mechanism that matters: pdfjs reaches for canvas with
 * `process.getBuiltinModule("module").createRequire(import.meta.url)("@napi-rs/canvas")`,
 * which goes through `Module._resolveFilename`. The ESM hook below covers a dynamic
 * `import()` of the same package, so the harness proves absence rather than absence-by-
 * one-particular-syntax.
 *
 * The error is a real MODULE_NOT_FOUND, not a custom one: pdfjs prints it into its warning
 * and the selftest's parser-unavailable signatures match on that text.
 */

const Module = require('node:module');

/** The package and every platform binary published alongside it. */
const BLOCKED = /^@napi-rs\/canvas(-[a-z0-9-]+)?$/;

function notFound(request) {
  const err = new Error(
    `Cannot find module '${request}' — blocked by scripts/no-canvas-preload.cjs to ` +
      `reproduce a host with no native canvas binary.`,
  );
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

/*
 * BOTH hooks, and the second one is the one that does the work.
 *
 * `_resolveFilename` alone is not enough under tsx: tsx installs its own CJS resolver,
 * and for a package with an `exports` map it answers the request itself instead of
 * delegating down the chain — so a block installed underneath it never sees
 * `@napi-rs/canvas`. Measured while writing this: the platform binary (no `exports`
 * field) was blocked and the package itself sailed through, which is a harness that
 * reports a pass for a condition it did not create.
 *
 * `_load` is what `require()` actually calls, and it is what pdfjs reaches through. A
 * later wrapper there delegates to whatever it found, so this one stays in the chain.
 */
const load = Module._load;
Module._load = function (request, ...rest) {
  if (BLOCKED.test(request)) throw notFound(request);
  return load.call(this, request, ...rest);
};

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (BLOCKED.test(request)) throw notFound(request);
  return resolveFilename.call(this, request, ...rest);
};

/** Proof the preload ran, for a harness that must not report a pass without it. */
globalThis.__resumerNoCanvasPreload = true;

/**
 * The ESM side. Registered from a data: URL rather than a second file, so the whole
 * condition stays in one place — a preload split across two files is one rename away
 * from silently blocking nothing.
 */
try {
  const { pathToFileURL } = require('node:url');
  Module.register(
    'data:text/javascript,' +
      encodeURIComponent(`
        const BLOCKED = ${BLOCKED.toString()};
        export async function resolve(specifier, context, next) {
          if (BLOCKED.test(specifier)) {
            const err = new Error("Cannot find package '" + specifier + "' — blocked by scripts/no-canvas-preload.cjs");
            err.code = 'ERR_MODULE_NOT_FOUND';
            throw err;
          }
          return next(specifier, context);
        }
      `),
    pathToFileURL(__filename),
  );
} catch {
  // Module.register landed in Node 20.6. The CJS patch above is the path pdfjs actually
  // takes, so an older runtime still reproduces the bug — it just covers less.
}

/** Exported so the harness can assert the block is real before it trusts a pass. */
module.exports = { BLOCKED };
