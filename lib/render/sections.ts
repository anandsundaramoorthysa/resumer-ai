/**
 * Which sections render as a plain paragraph rather than a bulleted list.
 *
 * Shared by both renderers on purpose. A summary bulleted as a single "•" line, or four
 * languages set as four bullets, reads as a formatting mistake to a human and gains
 * nothing with a parser — and the two renderers disagreeing about it is worse still,
 * because the DOCX and the PDF a candidate sends to two employers would not match.
 */

import type { SectionKey } from '../types';

const PLAIN_LINE_SECTIONS = new Set<SectionKey>([
  'summary',
  'skills',
  'languages',
  'interests',
]);

export function rendersAsPlainLine(key: SectionKey): boolean {
  return PLAIN_LINE_SECTIONS.has(key);
}
