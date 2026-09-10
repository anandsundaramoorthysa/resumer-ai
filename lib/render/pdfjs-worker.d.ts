/**
 * pdfjs ships its worker as plain JavaScript with no type declaration, and it is imported
 * for its side effect only — see the comment in selftest.ts: naming the file with a
 * literal specifier is what puts it in the deployed bundle, where pdfjs looks for it by
 * absolute path at runtime.
 *
 * It lives beside the file that imports it, rather than in a types/ directory, because
 * both tsconfigs include lib/ and only one of them would have found a top-level folder.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
