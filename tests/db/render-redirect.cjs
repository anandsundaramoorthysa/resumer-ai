/*
 * Redirects the PDF and DOCX renderers to tests/db/render-stub.mts for the `db-*` suites.
 *
 * `@react-pdf/renderer` cannot be loaded under tsx, and several modules reach it through a
 * RELATIVE import (lib/pipeline/run.ts imports '../render/pdf'), which a tsconfig `paths`
 * alias cannot intercept. Hooking CJS resolution catches every spelling of the same file.
 */
const Module = require('node:module');
const path = require('node:path');

const stub = path.join(__dirname, 'render-stub.mts');
const renderers = /[\\/]lib[\\/]render[\\/](pdf\.tsx?|docx\.tsx?)$/;

if (!Module.__renderRedirect) {
  Module.__renderRedirect = true;
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    const resolved = original.call(this, request, ...rest);
    return renderers.test(resolved) ? stub : resolved;
  };
}
