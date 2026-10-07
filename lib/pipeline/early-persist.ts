/**
 * What the draft route sends when the resume was saved but a later step threw.
 *
 * The snapshot is persisted as soon as the quality gate finishes (`onGenerated` in
 * lib/pipeline/run.ts), before the PDF/DOCX render. If the render, or anything after the
 * save, then throws, the user still has a resume — the right answer is the same `complete`
 * frame the client already understands, not an error that says "nothing was saved".
 */

import type { GeneratedDraft } from './run';

export function salvagedCompletePayload(g: GeneratedDraft, snapshotId: string): Record<string, unknown> {
  return {
    snapshotId,
    score: g.score,
    job: g.job,
    selfTest: {
      pdfPassed: false,
      docxPassed: false,
      issues: ['The file check did not finish. Your resume is saved; the files are built again when you download.'],
    },
    fileNames: { pdf: g.pdfName, docx: g.docxName },
    document: g.document,
    fit: g.fit,
    salvaged: true,
  };
}
