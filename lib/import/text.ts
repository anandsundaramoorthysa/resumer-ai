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

import mammoth from 'mammoth';
import { extractTextFromPdf } from '../render/selftest';
import { NotAZipError, ZipLimitError, inflatedSize } from './zip';

export type UploadFormat = 'pdf' | 'docx';

/** Nothing legitimate is bigger; anything that is, is not a resume. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * What a DOCX is allowed to expand to once it is unzipped.
 *
 * `MAX_UPLOAD_BYTES` is a cap on the COMPRESSED bytes, and that was never a bound on
 * what reading them costs. A DOCX is a ZIP; mammoth hands it to jszip, which inflates
 * `word/document.xml` with no output ceiling at all. Deflate reaches roughly 1032:1, so
 * a structurally valid 8MB DOCX whose document.xml is one byte repeated expands toward
 * eight gigabytes — and the function does not return a 422, it dies, either out of
 * memory or on V8's maximum string length. On a serverless host that is a killed
 * instance, and any signed-in user could post one to /api/draft or /api/import/extract
 * as often as they liked.
 *
 * So the archive is measured before mammoth sees it, using the same `inflateRawSync`
 * ceiling the LinkedIn `.zip` path has always used (lib/import/zip.ts). The numbers are
 * far above any real document — a hundred-page resume's document.xml is a few hundred
 * kilobytes, and the images in an 8MB DOCX are already-compressed bytes that barely
 * expand at all — and far below what a serverless instance can survive.
 */
const MAX_DOCX_INFLATED_BYTES = 32 * 1024 * 1024;
const MAX_DOCX_PART_BYTES = 16 * 1024 * 1024;
/** Word writes a couple of dozen parts. A thousand is generous; a million is an attack. */
const MAX_DOCX_PARTS = 1_024;

/** A file that was refused before it was read, rather than after it took the host down. */
export class UnsafeUploadError extends Error {}

/**
 * Refuses a DOCX that would cost too much to open.
 *
 * Deliberately fail-closed: an archive this reader cannot make sense of is rejected
 * rather than passed through on the hope that jszip will cope, because "our parser
 * disagrees with theirs" is exactly the shape a bypass would take. The cost is that a
 * ZIP64 DOCX — which an 8MB file has no reason to be — is refused too.
 */
export function assertDocxIsSafeToExtract(buffer: Buffer): void {
  try {
    inflatedSize(buffer, {
      maxEntryBytes: MAX_DOCX_PART_BYTES,
      maxTotalBytes: MAX_DOCX_INFLATED_BYTES,
      maxEntries: MAX_DOCX_PARTS,
    });
  } catch (err) {
    if (err instanceof ZipLimitError) {
      throw new UnsafeUploadError(
        `that DOCX expands to far more than a document should when it is opened (${err.message}), so it was not read`,
      );
    }
    if (err instanceof NotAZipError) {
      throw new UnsafeUploadError(
        'that file is named .docx but is not a readable Word document',
      );
    }
    throw err;
  }
}

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
  // Before the bytes reach a decompressor without an output ceiling of its own.
  if (format === 'docx') assertDocxIsSafeToExtract(buffer);

  const raw =
    format === 'docx'
      ? await docxTextWithBreaks(buffer)
      : await extractTextFromPdf(buffer);

  const cleaned = normalize(raw);
  const truncated = cleaned.length > MAX_TEXT_CHARS;
  const text = truncated ? cleaned.slice(0, MAX_TEXT_CHARS) : cleaned;

  return { text, chunks: chunkResumeText(text), truncated };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Upload text for a DOCX. mammoth's raw-text mode drops <w:br/> and the boundaries between
 * table cells, which glued a two-column resume into "SKILLSPython...EXPERIENCESoftware
 * Engineer". Its HTML mode keeps <br>, <p>, <td>, so line ends are rebuilt from that.
 * (Not used for the self-test of our own output, which has no tables.)
 */
async function docxTextWithBreaks(buffer: Buffer): Promise<string> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|td|th|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
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
