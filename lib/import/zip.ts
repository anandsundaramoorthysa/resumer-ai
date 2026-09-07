/**
 * Reading a ZIP archive, for the LinkedIn data export.
 *
 * A dependency was the obvious alternative and was rejected: this needs to read a
 * handful of small CSV files out of one trusted-format archive, and every ZIP library on
 * npm carries a decade of format edge cases — encryption, spanning, ZIP64, arbitrary
 * extra fields — that are attack surface here rather than features. `zlib` already does
 * the only hard part.
 *
 * The central directory is read rather than scanning for local file headers, because a
 * local header may declare sizes of zero and defer them to a data descriptor after the
 * compressed bytes. The central directory always carries the real sizes.
 *
 * Only the two methods LinkedIn's export actually uses are supported: stored (0) and
 * deflate (8). Anything else is reported by name rather than decoded wrongly.
 */

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path as stored in the archive, e.g. "Positions.csv". */
  name: string;
  bytes: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The end-of-central-directory record sits last, after a comment of up to 64KB. */
function findEndOfCentralDirectory(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

export class NotAZipError extends Error {}

/**
 * Every entry in the archive, decompressed.
 *
 * `maxEntryBytes` bounds a single decompressed file. A ZIP can claim a small compressed
 * size and expand enormously, and this runs inside a serverless function with a fixed
 * memory ceiling — an unbounded inflate is a crash, not an error message.
 */
export function readZip(
  buf: Buffer,
  options: { maxEntryBytes?: number; maxEntries?: number } = {},
): ZipEntry[] {
  const maxEntryBytes = options.maxEntryBytes ?? 8 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 500;

  if (buf.length < 22) throw new NotAZipError('That file is too small to be a zip archive.');

  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) {
    throw new NotAZipError(
      'That does not look like a zip archive — no end-of-archive record was found.',
    );
  }

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) {
    throw new NotAZipError('That archive uses ZIP64, which is not supported here.');
  }

  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount && i < maxEntries; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    // Directory entries and anything implausibly large are skipped rather than failing
    // the whole import: one unreadable member should not cost the user the other twelve.
    if (name.endsWith('/')) continue;
    if (uncompressedSize > maxEntryBytes) continue;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      continue;
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (end > buf.length) continue;

    const raw = buf.subarray(start, end);
    try {
      if (method === 0) entries.push({ name, bytes: Buffer.from(raw) });
      else if (method === 8) {
        entries.push({ name, bytes: inflateRawSync(raw, { maxOutputLength: maxEntryBytes }) });
      }
      // Any other method is left out; the caller reports which expected files are absent,
      // which is more useful than a compression-method number.
    } catch {
      continue;
    }
  }

  return entries;
}
