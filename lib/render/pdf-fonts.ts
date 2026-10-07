/**
 * Fonts for the PDF — Latin (with the rupee sign), Devanagari and Tamil, embedded.
 *
 * The renderer used Helvetica, a built-in font with no glyph for "₹" (printed as "¹"), none
 * for Devanagari or Tamil (garbage), and none for emoji (dropped). A resume for an Indian
 * market with the salary figure in rupees and a name in the candidate's own script could not
 * be produced correctly.
 *
 * Three families are registered and passed to react-pdf as a font STACK: for every
 * character it picks the first family that has a glyph for it, so a line mixing English and
 * Hindi is set in both without the code splitting text into runs. Because the fonts are
 * embedded with a ToUnicode map, the text layer an ATS reads extracts as the real characters
 * (verified in tests/pdf-fonts.test.mts by rendering and reading the PDF back).
 *
 * The bytes come from ./fonts/data.ts, a generated module — see scripts/build-font-data.mts
 * for why that, rather than reading the TTFs at run time, is the form that is certain to be
 * in a serverless bundle.
 */

import { Font } from '@react-pdf/renderer';
import { FONT_DATA } from './fonts/data';

export const PDF_FONT_STACK = ['NotoSans', 'NotoSansDevanagari', 'NotoSansTamil'] as const;

const toUri = (name: string): string => `data:font/ttf;base64,${FONT_DATA[name]}`;

let registered = false;

export function registerPdfFonts(): void {
  if (registered) return;
  registered = true;
  for (const family of PDF_FONT_STACK) {
    Font.register({
      family,
      fonts: [
        { src: toUri(`${family}-Regular`), fontWeight: 400 },
        { src: toUri(`${family}-Bold`), fontWeight: 700 },
      ],
    });
  }
}
