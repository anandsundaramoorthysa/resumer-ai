/**
 * Reading a ZIP archive, for the LinkedIn data export — and, through `inflatedSize`,
 * bounding one that a different library is about to read (a DOCX is a ZIP, and
 * `lib/import/text.ts` measures it here before mammoth's jszip touches it).
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
 * An archive that would cost more to decompress than the caller allowed.
 *
 * Separate from `NotAZipError` because the two need different answers: a file that is
 * not a zip is a user mistake, while one that inflates past the ceiling is either a
 * corrupt document or someone probing for a way to exhaust the instance.
 */
export class ZipLimitError extends Error {}

/** One member of the archive, located but not yet decompressed. */
interface CentralEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else this file does not decode. */
  method: number;
  /**
   * The uncompressed size the central directory CLAIMS. Attacker-controlled, so it is
   * only ever good for a cheap early reject — never for sizing a buffer or trusting.
   */
  declaredSize: number;
  /** Offsets of the compressed bytes within `buf`. */
  start: number;
  end: number;
}

/** The end-of-central-directory record, or an explanation of why there isn't one. */
function readEndOfCentralDirectory(buf: Buffer): { entryCount: number; offset: number } {
  if (buf.length < 22) throw new NotAZipError('That file is too small to be a zip archive.');

  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) {
    throw new NotAZipError(
      'That does not look like a zip archive — no end-of-archive record was found.',
    );
  }

  const offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) {
    throw new NotAZipError('That archive uses ZIP64, which is not supported here.');
  }

  return { entryCount: buf.readUInt16LE(eocd + 10), offset };
}

/**
 * Walks the central directory and locates each member's compressed bytes, inflating
 * nothing. Split out of `readZip` so that a caller who only needs to know what an
 * archive would cost to decompress can find that out without paying it — see
 * `inflatedSize`.
 *
 * Directory entries and members whose local header does not agree with the central
 * directory are skipped rather than reported: this is a locator, and the decision about
 * what an unreadable member means belongs to the caller.
 */
function* centralDirectory(buf: Buffer, maxEntries: number): Generator<CentralEntry> {
  const { entryCount, offset: start } = readEndOfCentralDirectory(buf);
  let offset = start;

  for (let i = 0; i < entryCount && i < maxEntries; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const declaredSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      continue;
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const bodyStart = localOffset + 30 + localNameLength + localExtraLength;
    const bodyEnd = bodyStart + compressedSize;
    if (bodyEnd > buf.length) continue;

    yield { name, method, declaredSize, start: bodyStart, end: bodyEnd };
  }
}

/**
 * What this archive really inflates to, measured by inflating it and keeping nothing.
 *
 * This exists for a caller that must hand the original bytes to some other library —
 * mammoth, which reads a DOCX through jszip — and needs to know first that doing so is
 * survivable. A compressed-size cap answers a different question: deflate reaches about
 * 1032:1, so eight megabytes on the wire is eight gigabytes in memory, and a library
 * with no output ceiling turns that into a killed instance rather than an error.
 *
 * Both halves of the check are needed:
 *
 *   - the declared total is free (the central directory states it) and refuses a bomb
 *     that is honest about its size before a single byte is inflated;
 *   - inflating under `maxOutputLength` is the real bound, because a declared size is
 *     whatever the archive says it is and can understate the truth by any factor.
 *
 * The entry count is checked against the same ceiling `centralDirectory` truncates at,
 * so a padded archive cannot hide members past the limit that the other library would
 * still go on to decompress.
 *
 * Throws `ZipLimitError` if the archive breaches a ceiling or holds a member this file
 * cannot decode — never a size that was merely guessed at.
 */
export function inflatedSize(
  buf: Buffer,
  options: { maxEntryBytes: number; maxTotalBytes: number; maxEntries?: number },
): number {
  const { maxEntryBytes, maxTotalBytes } = options;
  const maxEntries = options.maxEntries ?? 500;

  const { entryCount } = readEndOfCentralDirectory(buf);
  if (entryCount > maxEntries) {
    throw new ZipLimitError(`the archive holds ${entryCount} files, more than ${maxEntries}`);
  }

  const entries = [...centralDirectory(buf, maxEntries)];

  const declared = entries.reduce((n, e) => n + e.declaredSize, 0);
  if (declared > maxTotalBytes) {
    throw new ZipLimitError(
      `the archive says it expands to ${Math.round(declared / 1024 / 1024)}MB`,
    );
  }

  let total = 0;
  for (const entry of entries) {
    const remaining = maxTotalBytes - total;
    if (remaining <= 0) throw new ZipLimitError('the archive expands past its total ceiling');

    if (entry.method === 0) {
      total += entry.end - entry.start;
    } else if (entry.method === 8) {
      try {
        total += inflateRawSync(buf.subarray(entry.start, entry.end), {
          maxOutputLength: Math.min(maxEntryBytes, remaining),
        }).length;
      } catch (err) {
        // `maxOutputLength` reports the bomb; anything else here is a stream that does
        // not decode. Both mean the same thing to the caller — these bytes are not
        // safe to hand on — but the message should say which it was.
        const code = (err as { code?: string } | null)?.code;
        throw new ZipLimitError(
          code === 'ERR_BUFFER_TOO_LARGE'
            ? `"${entry.name}" alone expands past ${Math.round(maxEntryBytes / 1024 / 1024)}MB`
            : `"${entry.name}" is not a readable deflate stream`,
        );
      }
    } else {
      throw new ZipLimitError(`"${entry.name}" uses compression method ${entry.method}`);
    }

    if (total > maxTotalBytes) {
      throw new ZipLimitError('the archive expands past its total ceiling');
    }
  }

  return total;
}

/**
 * Every entry in the archive, decompressed.
 *
 * Three separate bounds, because one is not enough:
 *
 *   - `maxEntryBytes` caps a single decompressed file. A ZIP can declare a small size and
 *     expand enormously, so the real bound is `inflateRawSync`'s `maxOutputLength`.
 *   - `maxTotalBytes` caps everything kept, which the per-entry cap alone does not: five
 *     hundred entries each just under an 8MB ceiling is four gigabytes, from an archive
 *     of a few kilobytes, and every one of them is retained in the returned array.
 *   - `nameFilter` decides what is worth inflating at all, so an archive padded with
 *     files the caller will discard never costs anything to decompress.
 *
 * This runs inside a serverless function with a fixed memory ceiling, where exceeding it
 * is a crash rather than an error message.
 */
export function readZip(
  buf: Buffer,
  options: {
    maxEntryBytes?: number;
    maxEntries?: number;
    maxTotalBytes?: number;
    nameFilter?: (name: string) => boolean;
  } = {},
): ZipEntry[] {
  const maxEntryBytes = options.maxEntryBytes ?? 8 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 500;
  const maxTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024;
  const nameFilter = options.nameFilter;

  const entries: ZipEntry[] = [];
  let totalBytes = 0;

  for (const { name, method, declaredSize, start, end } of centralDirectory(buf, maxEntries)) {
    // Anything implausibly large is skipped rather than failing the whole import: one
    // unreadable member should not cost the user the other twelve.
    if (declaredSize > maxEntryBytes) continue;
    // The declared size is attacker-controlled, so it is a cheap early reject and never
    // the real bound — that is maxOutputLength below.
    if (nameFilter && !nameFilter(name)) continue;

    const raw = buf.subarray(start, end);
    try {
      // Never inflate more than the remaining budget, so the last entry cannot blow past
      // the total on its own.
      const remaining = maxTotalBytes - totalBytes;
      if (remaining <= 0) break;

      let bytes: Buffer | null = null;
      if (method === 0) bytes = Buffer.from(raw.subarray(0, Math.min(raw.length, remaining)));
      else if (method === 8) {
        bytes = inflateRawSync(raw, { maxOutputLength: Math.min(maxEntryBytes, remaining) });
      }
      // Any other method is left out; the caller reports which expected files are absent,
      // which is more useful than a compression-method number.
      if (!bytes) continue;

      entries.push({ name, bytes });
      totalBytes += bytes.length;
      if (totalBytes >= maxTotalBytes) break;
    } catch {
      continue;
    }
  }

  return entries;
}
