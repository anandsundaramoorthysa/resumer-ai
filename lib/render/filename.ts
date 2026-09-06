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
