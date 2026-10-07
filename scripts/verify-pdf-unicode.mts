/**
 * The PDF must print and extract ₹, Devanagari and Tamil — and must not print emoji as boxes.
 *
 * Helvetica, the font the renderer used, has no glyph for any of them: "₹" came out as "¹",
 * Hindi and Tamil as garbage, emoji vanished. This renders a real PDF with the embedded Noto
 * fonts (lib/render/pdf-fonts.ts) and reads it back through the same extractor an ATS
 * would use (pdf-parse), asserting the characters survive.
 *
 * WHY A SEPARATE SCRIPT AND NOT A tests/*.test.mts SUITE
 *
 * `@react-pdf/renderer` publishes export conditions tsx cannot resolve
 * (tests/render.test.mts records this), so the PDF renderer cannot be imported into a tsx
 * process. This script bundles lib/render/pdf.tsx with esbuild — node_modules stay external,
 * so Node resolves @react-pdf the way the Next runtime does — and imports the bundle.
 * tests/pdf-fonts.test.mts runs it as a child process, so `npm test` covers it.
 *
 * Also runs under scripts/no-canvas-preload.cjs when RESUMER_NO_CANVAS=1, like the CI step
 * 'verify-pdf-without-canvas': the text layer must extract on a host with no native canvas.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/verify-pdf-unicode.mts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'node_modules', '.cache', 'resumer-verify-pdf');
mkdirSync(outDir, { recursive: true });

// A virtual entry exporting the two functions under test.
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export { renderResumePdf, withoutUnrenderable } from ${JSON.stringify(join(root, 'lib/render/pdf.tsx').replace(/\\/g, '/'))};`,
    `export { extractTextFromPdf } from ${JSON.stringify(join(root, 'lib/render/selftest.ts').replace(/\\/g, '/'))};`,
  ].join('\n'),
);

const outfile = join(outDir, 'bundle.mjs');
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
  tsconfig: join(here, 'tsconfig.json'),
  logLevel: 'error',
});

const { renderResumePdf, extractTextFromPdf } = (await import(pathToFileURL(outfile).href)) as {
  renderResumePdf: (doc: unknown) => Promise<Buffer>;
  extractTextFromPdf: (buf: Buffer) => Promise<string>;
};

const ZWJ = String.fromCharCode(0x200d);
const doc = {
  id: 'd',
  userId: 'u',
  contact: { fullName: 'आनंद शर्मा', email: 'anand@example.com', phone: '+91 90000 00000' },
  sections: [
    {
      key: 'summary',
      heading: 'Summary',
      items: [
        {
          text: `Saved ₹5 lakh for Tata. Hindi: पायथन जावा. Tamil: தமிழ் இன்ஃபோசிஸ். Emoji 😀 ok 👨${ZWJ}👩${ZWJ}👧 done.`,
          sourceRecordId: null,
        },
      ],
    },
    {
      key: 'experience',
      heading: 'Experience',
      items: [],
      groups: [
        {
          title: 'டெவலப்பர்',
          subtitle: 'इन्फोसिस',
          dateRange: '2020 – 2022',
          items: [{ text: 'Cut cost by ₹10 crore — “quoted” café', sourceRecordId: null }],
        },
      ],
    },
  ],
  renderMode: 'ats-strict',
  recordHashSnapshot: [],
  createdAt: new Date(),
};

const buffer = await renderResumePdf(doc);
const text = (await extractTextFromPdf(buffer)).replace(/\s+/g, ' ');

const failures: string[] = [];
const must = (label: string, needle: string) => {
  if (!text.includes(needle)) failures.push(`missing ${label}: ${needle}`);
};
must('rupee amount', '₹5 lakh');
must('rupee amount, second', '₹10 crore');
// Complex scripts: the PDF DRAWS conjuncts correctly, but a PDF text layer holds glyphs in
// visual order, so a reph (र्) or a pre-base vowel sign (ெ, ि) extracts a few places away
// from where it is typed — 'शर्मा' reads back as 'शमार्'. That is a property of PDF text
// extraction for Indic scripts, not of the fonts. What this checks is that every word comes
// back as the same letters (no glyph lost, none replaced by a box or a Latin look-alike).
const letters = (w: string) => Array.from(w.normalize('NFD')).sort().join('');
const tokens = text.split(/[\s.,|]+/).map(letters);
const sameLetters = (label: string, word: string) => {
  if (!tokens.includes(letters(word))) failures.push('missing letters of ' + label + ': ' + word);
};
sameLetters('Devanagari name, first word', 'आनंद');
sameLetters('Devanagari name, second word', 'शर्मा');
sameLetters('Devanagari word', 'पायथन');
sameLetters('Devanagari word', 'जावा');
sameLetters('Devanagari company', 'इन्फोसिस');
sameLetters('Tamil word', 'தமிழ்');
sameLetters('Tamil company line', 'டெவலப்பர்');
must('curly quotes and accents', '“quoted” café');
if (/[\u{1f300}-\u{1faff}]/u.test(text)) failures.push('an emoji reached the text layer');
if (text.includes('¹')) failures.push('rupee sign was drawn as a superscript one (Helvetica regression)');
if (!text.includes('ok') || !text.includes('done')) failures.push('text around the removed emoji was lost');

console.log(`pdf bytes: ${buffer.length}`);
console.log(`extracted: ${JSON.stringify(text.slice(0, 400))}`);
if (failures.length > 0) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('OK: ₹, Devanagari and Tamil survive the round trip; emoji are removed, not boxed.');
