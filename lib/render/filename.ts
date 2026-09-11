/**
 * Export file naming — REQ-6.4.
 * `Anand_Sundaramoorthy_Senior_Full_Stack_Engineer.pdf`, never `resume_final_v2.pdf`.
 */

import type { ResumeDocument } from '../types';

function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('_');
}

export function resumeFileName(
  doc: ResumeDocument,
  ext: 'pdf' | 'docx',
): string {
  const name = slug(doc.contact.fullName || 'Resume');
  const target = doc.jobRequirement
    ? slug(doc.jobRequirement.company || doc.jobRequirement.roleTitle)
    : 'Resume';
  const parts = [name, target].filter(Boolean);
  return `${parts.join('_')}.${ext}`;
}

/**
 * The Content-Disposition value for a download named `fileName`.
 *
 * A header value must be bytes, so `filename="北京_Tech.pdf"` threw inside the Response
 * constructor and the export returned 500 for any name or company written in Tamil,
 * Devanagari, Chinese or another non-Latin script — the slug above keeps those letters on
 * purpose. RFC 6266: an ASCII fallback for old clients, and the real name UTF-8 encoded in
 * `filename*` for every current browser.
 */
export function attachmentHeader(fileName: string): string {
  // The slug holds only letters, digits, underscores and the extension's dot, so dropping
  // everything outside printable ASCII is all the fallback needs.
  const ext = fileName.slice(fileName.lastIndexOf('.'));
  const base = fileName
    .slice(0, -ext.length)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');
  return `attachment; filename="${base || 'Resume'}${ext}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
