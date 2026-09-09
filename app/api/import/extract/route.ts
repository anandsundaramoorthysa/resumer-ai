/**
 * Upload step of the old-resume importer — task 2.1.
 *
 * The file is read straight out of the multipart body into memory and never stored.
 * There is no blob store in the deployment and there does not need to be one: the only
 * thing worth keeping from a resume PDF is the text, the text is a few kilobytes, and
 * not persisting the original means there is no uploaded-document retention question to
 * answer later.
 *
 * Returns the chunks rather than the whole job, because the extraction that follows is
 * one short request per chunk (see ../parse/route.ts).
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import {
  MAX_UPLOAD_BYTES,
  UnsafeUploadError,
  extractUploadText,
  formatFromFile,
} from '@/lib/import/text';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: 'Expected a file upload.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'No file was attached.' }, { status: 400 });
  }

  if (file.size === 0) {
    return Response.json({ error: 'That file is empty.' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      {
        error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${
          MAX_UPLOAD_BYTES / 1024 / 1024
        } MB — a resume is normally well under 1 MB.`,
      },
      { status: 413 },
    );
  }

  const format = formatFromFile(file.name, file.type);
  if (!format) {
    return Response.json(
      { error: 'Only PDF and DOCX files can be read. Export your resume as one of those.' },
      { status: 415 },
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { text, chunks, truncated } = await extractUploadText(buffer, format);

    // A scanned or image-only PDF extracts to almost nothing. Saying so is far more
    // use than sending an empty document through four AI calls to reach the same
    // conclusion slowly.
    if (text.replace(/\s+/g, '').length < 120) {
      return Response.json(
        {
          error:
            format === 'pdf'
              ? 'That PDF has no readable text layer — it looks like a scan or an image export. Upload the original, or a DOCX version.'
              : 'That DOCX contained almost no text.',
        },
        { status: 422 },
      );
    }

    return Response.json({
      fileName: file.name,
      format,
      charCount: text.length,
      chunks,
      truncated,
    });
  } catch (err) {
    // Kept identical to the draft route's rule on purpose: these two are the only
    // places a user hands this app a file, and if they disagree about what an error
    // may say, the safer one is one refactor from being "corrected" to match the other.
    if (!(err instanceof UnsafeUploadError)) {
      console.error('[import] upload could not be read for user', session.user.id, err);
    }
    return Response.json(
      {
        error:
          err instanceof UnsafeUploadError
            ? `Could not read that file: ${err.message}`
            : 'That file could not be read. If it is a PDF, make sure it is not a scan; otherwise try a DOCX.',
      },
      { status: 422 },
    );
  }
}
