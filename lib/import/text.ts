/**
 * Uploaded-resume text extraction and chunking — REQ-1.2 (`ai-import` provenance).
 *
 * Two jobs, both deterministic and free: turn the uploaded bytes into plain text, and
 * cut that text into pieces small enough that a single AI call over one piece finishes
 * inside one ordinary request.
 *
 * The extractors are the ones the round-trip self-test already uses, so an uploaded
 * resume is read by exactly the same code path that verifies a generated one.
 */

import { extractTextFromDocx, extractTextFromPdf } from '../render/selftest';

export type UploadFormat = 'pdf' | 'docx';

/** Nothing legitimate is bigger; anything that is, is not a resume. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * A long resume runs to ~8k characters. The cap is generous enough to never truncate a
 * real one, and low enough that a mistakenly uploaded book can't turn into 200 AI calls.
 */
export const MAX_TEXT_CHARS = 40_000;

/**
 * Chunk size, set from the measurement recorded in lib/sync/parse.ts: a 73k-char prompt
 * took 138s and then failed, a 1.5k-char prompt took 6.2s and succeeded. Small inputs
 * are the whole difference, so a chunk is sized to land in that fast band rather than
 * to minimise the number of calls.
 */
export const MAX_CHUNK_CHARS = 1_400;

export function formatFromFile(name: string, mimeType: string): UploadFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') return 'pdf';
  if (
    lower.endsWith('.docx') ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  return null;
}

export interface ExtractedUpload {
  text: string;
  chunks: string[];
  truncated: boolean;
}

export async function extractUploadText(
  buffer: Buffer,
  format: UploadFormat,
): Promise<ExtractedUpload> {
  const raw =
    format === 'docx'
      ? await extractTextFromDocx(buffer)
      : await extractTextFromPdf(buffer);

  const cleaned = normalize(raw);
  const truncated = cleaned.length > MAX_TEXT_CHARS;
  const text = truncated ? cleaned.slice(0, MAX_TEXT_CHARS) : cleaned;

  return { text, chunks: chunkResumeText(text), truncated };
}

/**
 * PDF extraction leaves the artefacts of a page layout behind: soft-hyphenated line
 * breaks, ragged single-line wraps, and page furniture. Collapsing them here means the
 * model reads sentences rather than column fragments.
 */
function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '') // soft hyphen
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * Splits on blank lines first, because a resume's own paragraph breaks are the most
 * reliable semantic boundary available without parsing its layout. A paragraph is only
 * cut mid-way when it alone exceeds the chunk size, which in practice means a wall of
 * text with no blank lines at all.
 */
export function chunkResumeText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      flush();
      for (const piece of hardSplit(para, maxChars)) chunks.push(piece);
      continue;
    }
    if (current.length + para.length + 2 > maxChars) flush();
    current = current ? `${current}\n\n${para}` : para;
  }
  flush();

  return chunks;
}

/** Last resort for an unbroken block: cut on line ends, then on raw length. */
function hardSplit(para: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of para.split('\n')) {
    if (line.length > maxChars) {
      if (current) out.push(current);
      current = '';
      for (let i = 0; i < line.length; i += maxChars) {
        out.push(line.slice(i, i + maxChars));
      }
      continue;
    }
    if (current.length + line.length + 1 > maxChars) {
      out.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) out.push(current);
  return out.filter((c) => c.trim().length > 0);
}
