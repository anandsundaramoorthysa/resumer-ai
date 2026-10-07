/**
 * PDF fonts — lib/render/pdf-fonts.ts, lib/render/unrenderable.ts.
 *
 * The renderer used Helvetica: "₹" printed as "¹", Hindi and Tamil as garbage, emoji
 * vanished. The real round trip (render a PDF, read it back with the ATS extractor) needs
 * `@react-pdf/renderer`, which tsx cannot import, so it lives in
 * scripts/verify-pdf-unicode.mts and is run here as a child process.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { assert, report, suite, test, testAsync } from './harness.mjs';
import { stripUnrenderable } from '@/lib/render/unrenderable';
import { FONT_DATA } from '@/lib/render/fonts/data';

const root = process.cwd();
const ZWJ = String.fromCharCode(0x200d);

suite('emoji are removed, not drawn as boxes', () => {
  test('emoji, ZWJ sequences, flags and skin tones go; the words around them stay', () => {
    const r = stripUnrenderable(`Shipped 🚀 fast 👨${ZWJ}👩${ZWJ}👧 team 👍🏽 in 🇮🇳 India`);
    assert.equal(r.text, 'Shipped fast team in India');
    assert.equal(r.removed, 4 + 1 + 0, 'rocket, family, thumbs-up, flag');
  });
  test('rupee sign, bullets, arrows, accents, Indic text and (c)(r)(tm) are untouched', () => {
    const text = 'Saved ₹5 lakh • café → आनंद தமிழ் © ® ™  two  spaces';
    const r = stripUnrenderable(text);
    assert.equal(r.text, text);
    assert.equal(r.removed, 0);
  });
});

suite('the embedded fonts', () => {
  test('the generated module is exactly the TTFs on disk', () => {
    const names = Object.keys(FONT_DATA);
    assert.equal(names.length, 6);
    for (const name of names) {
      const file = readFileSync(join(root, 'lib', 'render', 'fonts', `${name}.ttf`));
      assert.equal(FONT_DATA[name], file.toString('base64'), `${name}: re-run scripts/build-font-data.mts`);
    }
  });
  test('each family ships its licence', () => {
    for (const l of ['OFL-NotoSans.txt', 'OFL-NotoSansDevanagari.txt', 'OFL-NotoSansTamil.txt']) {
      const text = readFileSync(join(root, 'lib', 'render', 'fonts', l), 'utf8');
      assert.ok(text.includes('SIL OPEN FONT LICENSE') || text.includes('SIL Open Font License'), l);
    }
  });
  test('Latin font covers the rupee sign; Devanagari and Tamil fonts cover their scripts', () => {
    const fontkit = createRequire(join(root, 'package.json'))('fontkit') as {
      create(b: Buffer): { hasGlyphForCodePoint(c: number): boolean };
    };
    const open = (n: string) => fontkit.create(Buffer.from(FONT_DATA[n], 'base64'));
    assert.ok(open('NotoSans-Regular').hasGlyphForCodePoint(0x20b9), 'rupee in Noto Sans');
    assert.ok(open('NotoSans-Bold').hasGlyphForCodePoint(0x20b9), 'rupee in Noto Sans Bold');
    assert.ok(open('NotoSansDevanagari-Regular').hasGlyphForCodePoint(0x0906));
    assert.ok(open('NotoSansTamil-Regular').hasGlyphForCodePoint(0x0b86));
  });
});

console.log('\nrender and read back (₹, Devanagari and Tamil in the text layer; emoji gone)');
await testAsync('scripts/verify-pdf-unicode.mts passes', async () => {
  const run = spawnSync(
    process.execPath,
    [createRequire(import.meta.url).resolve('tsx/cli'), '--tsconfig', join(root, 'scripts', 'tsconfig.json'), join(root, 'scripts', 'verify-pdf-unicode.mts')],
    { cwd: root, encoding: 'utf8', timeout: 180_000 },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-1500));
});

report('pdf-fonts');
