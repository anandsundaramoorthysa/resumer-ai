/**
 * ATS-safe DOCX renderer — REQ-6.1, REQ-6.3.
 *
 * Walks the SAME ResumeDocument the PDF renderer walks, so the two outputs can never
 * drift. Arial, single column, no tables, no text boxes, no header/footer — the contact
 * block is ordinary body paragraphs, because many parsers skip header/footer regions
 * entirely and a resume whose contact info lives there can parse as anonymous.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from 'docx';
import type { ResumeDocument } from '../types';
import { coerceHeading } from './headings';
import { tidyResumeText } from '../generate/display-text';
import { rendersAsPlainLine } from './sections';

/**
 * Arial for Latin, with explicit fallbacks for the other scripts. A run names ONE font per
 * script class (ascii/hAnsi for Latin, cs for complex scripts such as Devanagari and Tamil,
 * eastAsia for CJK); with only Arial named, Word substituted at open time and a machine
 * without the substitute showed boxes. Nirmala UI covers Devanagari and Tamil on Windows
 * and ships with Office for Mac; Microsoft YaHei covers CJK. Arial itself has the rupee sign.
 */
const FONT = { ascii: 'Arial', hAnsi: 'Arial', cs: 'Nirmala UI', eastAsia: 'Microsoft YaHei' };
const BODY_SIZE = 21; // half-points => 10.5pt
const NAME_SIZE = 36; // 18pt
const HEADING_SIZE = 23; // 11.5pt

function body(text: string, opts: { bold?: boolean; italics?: boolean; size?: number } = {}): TextRun {
  return new TextRun({
    text,
    font: FONT,
    size: opts.size ?? BODY_SIZE,
    bold: opts.bold ?? false,
    italics: opts.italics ?? false,
  });
}

/** A4 width less the 900-twip side margins: where a right-aligned date sits. */
const RIGHT_EDGE = 11906 - 900 * 2;
/** Where skill values start, so wrapped lines align under the first. */
const SKILL_COLUMN = 2600;

function bulletParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [body(text)],
    bullet: { level: 0 },
    spacing: { after: 40 },
  });
}

export async function renderResumeDocx(doc: ResumeDocument): Promise<Buffer> {
  // REQ-6.2 makes presentation mode PDF-only, and this is where that is enforced rather
  // than merely intended. A DOCX is the format people paste into a portal's own editor,
  // where the styling is discarded and only the parse survives — so the one variant
  // whose whole point is styling must not be obtainable in it.
  if (doc.renderMode === 'presentation') {
    throw new Error(
      'Presentation mode is PDF-only. Export the ats-strict version for DOCX.',
    );
  }
  doc = tidyResumeText(doc);

  const children: Paragraph[] = [];
  const c = doc.contact;

  // --- Contact block, in the body ------------------------------------------
  children.push(
    new Paragraph({
      children: [body(c.fullName, { bold: true, size: NAME_SIZE })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
    }),
  );

  const contactBits = [c.email, c.phone, c.location].filter(Boolean) as string[];
  if (contactBits.length > 0) {
    children.push(
      new Paragraph({
        children: [body(contactBits.join('  |  '), { size: 19 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 30 },
      }),
    );
  }

  const links = [c.portfolioUrl, c.githubUrl, c.linkedinUrl].filter(Boolean) as string[];
  if (links.length > 0) {
    const runs: (TextRun | ExternalHyperlink)[] = [];
    links.forEach((url, i) => {
      if (i > 0) runs.push(body('  |  ', { size: 19 }));
      // Visible text is the URL itself (REQ-6.1).
      runs.push(
        new ExternalHyperlink({
          link: ensureProtocol(url),
          children: [
            new TextRun({
              text: stripProtocol(url),
              font: FONT,
              size: 19,
              // No blue-underline styling: keeps it readable as plain text if the
              // hyperlink relationship is stripped during parsing.
            }),
          ],
        }),
      );
    });
    children.push(
      new Paragraph({ children: runs, alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
    );
  }

  // --- Sections -------------------------------------------------------------
  for (const section of doc.sections) {
    children.push(
      new Paragraph({
        children: [
          body(coerceHeading(section.key, section.heading).toUpperCase(), {
            bold: true,
            size: HEADING_SIZE,
          }),
        ],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 220, after: 80 },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 2 },
        },
      }),
    );

    for (const item of section.items) {
      const colon = item.text.indexOf(': ');
      if (section.key === 'skills' && colon > 0) {
        children.push(
          new Paragraph({
            tabStops: [{ type: TabStopType.LEFT, position: SKILL_COLUMN }],
            indent: { left: SKILL_COLUMN, hanging: SKILL_COLUMN },
            children: [
              body(item.text.slice(0, colon + 1), { bold: true }),
              body(`\t${item.text.slice(colon + 2)}`),
            ],
            spacing: { after: 40 },
          }),
        );
      } else if (rendersAsPlainLine(section.key)) {
        children.push(
          new Paragraph({ children: [body(item.text)], spacing: { after: 40 } }),
        );
      } else {
        children.push(bulletParagraph(item.text));
      }
    }

    for (const [gi, group] of (section.groups ?? []).entries()) {
      // A run of one-line entries sits closer, as in the PDF.
      const inRun = gi > 0 && group.items.length === 0 && section.groups![gi - 1].items.length === 0;
      // Title left, dates right-aligned on the same line.
      const titleRuns: TextRun[] = [body(group.title, { bold: true })];
      if (group.subtitle) titleRuns.push(body(` — ${group.subtitle}`));
      if (group.dateRange) titleRuns.push(body(`\t${group.dateRange}`, { size: 19 }));
      children.push(
        new Paragraph({
          children: titleRuns,
          tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_EDGE }],
          spacing: { before: inRun ? 40 : 120, after: 20 },
        }),
      );
      for (const item of group.items) {
        children.push(
          section.key === 'education'
            ? new Paragraph({
                children: [body(item.text, { italics: true })],
                indent: { left: 200 },
                spacing: { after: 40 },
              })
            : bulletParagraph(item.text),
        );
      }
    }
  }

  const document = new Document({
    creator: 'Resumer AI',
    title: `${c.fullName} — Resume`,
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY_SIZE } },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(document);
}

function ensureProtocol(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

export { AlignmentType };
