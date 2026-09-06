/**
 * Section-heading allow-list — REQ-6.1.
 *
 * Recognized synonyms parse fine across every engine we researched; the real risk is
 * creative headers ("My Journey"). Headings are validated against this list at render
 * time and rejected rather than silently passed through.
 */

import type { SectionKey } from '../types';

export const HEADING_ALLOW_LIST: Record<SectionKey, string[]> = {
  summary: ['Summary', 'Professional Summary', 'Profile'],
  skills: ['Skills', 'Technical Skills', 'Core Skills', 'Skills & Tools'],
  experience: [
    'Experience',
    'Work Experience',
    'Professional Experience',
    'Employment History',
  ],
  projects: ['Projects', 'Selected Projects', 'Technical Projects'],
  education: ['Education'],
  certifications: ['Certifications', 'Certifications & Licenses'],
  // Papers and articles share one heading on purpose. Parsers keep databases of
  // recognised labels, and "Publications" is in all of them; a separate "Blog Posts"
  // or "Writing" heading is not, and an unrecognised heading loses the whole section.
  publications: ['Publications', 'Publications & Writing', 'Research'],
  awards: ['Awards', 'Awards & Honors', 'Honors & Awards'],
  achievements: ['Achievements', 'Achievements & Activities'],
  volunteering: ['Volunteer Experience', 'Leadership & Volunteering', 'Leadership'],
  languages: ['Languages'],
  interests: ['Interests', 'Interests & Activities'],
};

/** Canonical heading used when nothing else is specified. */
export function defaultHeading(key: SectionKey): string {
  return HEADING_ALLOW_LIST[key][0];
}

export function isAllowedHeading(key: SectionKey, heading: string): boolean {
  return HEADING_ALLOW_LIST[key].some(
    (h) => h.toLowerCase() === heading.trim().toLowerCase(),
  );
}

/**
 * Coerce to the nearest allowed heading. Used defensively at render time so a bad
 * heading can never reach the document — it becomes the canonical one instead.
 */
export function coerceHeading(key: SectionKey, heading: string | undefined): string {
  if (heading && isAllowedHeading(key, heading)) return heading.trim();
  return defaultHeading(key);
}
