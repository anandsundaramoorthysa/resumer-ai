/**
 * Reading an uploaded LinkedIn data export into review candidates.
 *
 * One request, no AI, no chunking — unlike the resume importer, which needs a model to
 * read prose and therefore has to be stepped around the function time limit. A CSV
 * archive parses in milliseconds, so the whole job fits in a single call.
 *
 * The archive is never stored. It is parsed in memory and the candidates are returned to
 * the browser, which is also what keeps the review step honest: nothing reaches the
 * profile until the user confirms it.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { buildLinkedInPreview } from '@/lib/import/linkedin';
import { NotAZipError, readZip } from '@/lib/import/zip';

import { guardMutation } from '@/lib/server/request-guard';

export const runtime = 'nodejs';

/** Comfortably above a real export, which is a few hundred kilobytes of CSV. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }

  const refused = guardMutation(req, { contentTypes: ['multipart/form-data'], maxBytes: MAX_UPLOAD_BYTES + 64 * 1024 });
  if (refused) return refused;

  // Checked before `formData()` buffers the body; chunked bodies cannot be bounded.
  const declared = Number(req.headers.get('content-length'));
  if (!req.headers.get('content-length') || !Number.isFinite(declared)) {
    return Response.json({ error: 'Upload size must be declared.' }, { status: 411 });
  }
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return Response.json(
      { error: 'That archive is larger than 25MB, which is far larger than a data export.' },
      { status: 413 },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'Attach the export archive.' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: 'That archive is larger than 25MB, which is far larger than a data export.' },
      { status: 413 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());

  // A single .csv is accepted too. LinkedIn sends the export in parts, and a user who
  // only wants their positions across should not have to rebuild a zip to do it.
  const files = new Map<string, string>();
  if (/\.csv$/i.test(file.name)) {
    files.set(file.name, buf.toString('utf8'));
  } else {
    try {
      // A real export is around thirty CSVs totalling a few hundred kilobytes. These
      // bounds are generous against that and hostile to an archive built to exhaust
      // memory — non-CSV members are never decompressed at all.
      const entries = readZip(buf, {
        maxEntries: 128,
        maxEntryBytes: 8 * 1024 * 1024,
        maxTotalBytes: 32 * 1024 * 1024,
        nameFilter: (name) => /\.csv$/i.test(name),
      });
      for (const entry of entries) files.set(entry.name, entry.bytes.toString('utf8'));
    } catch (err) {
      const message =
        err instanceof NotAZipError
          ? err.message
          : 'That archive could not be opened. Upload the .zip LinkedIn emailed you, unchanged.';
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (files.size === 0) {
    return Response.json(
      { error: 'No CSV files were found in that archive.' },
      { status: 400 },
    );
  }

  return Response.json(buildLinkedInPreview(files));
}
