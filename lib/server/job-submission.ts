/**
 * Reading a job submission off a request — the text, an attached file, or a sealed fit
 * check — for every route that accepts one.
 *
 * It lived inline in app/api/draft/route.ts, and the fit check (app/api/draft/assess)
 * needs exactly the same reading: the same two transports, the same size cap, the same
 * refusal to believe a browser's declared file type. A second copy of upload validation
 * is the kind that drifts — one route learns about a new malformed-file case and the
 * other does not — so there is one.
 */

import {
  MAX_UPLOAD_BYTES,
  UnsafeUploadError,
  extractUploadText,
  formatFromFile,
} from '@/lib/import/text';
import {
  fileRejection,
  hasReadableText,
  unreadableFileMessage,
  validateJobSubmission,
  type JobInputRejection,
} from '@/lib/intake/job-input';

import { JSON_MAX_BYTES, readJsonLimited } from '@/lib/server/request-guard';

/** For guardMutation: a typed/pasted job or a sealed fit check as JSON, or a job file as multipart. */
export const SUBMISSION_GUARD = {
  contentTypes: ['application/json', 'multipart/form-data'],
  maxBytes: MAX_UPLOAD_BYTES + 64 * 1024,
};

export type JobSubmission =
  | {
      ok: true;
      jobInput: string;
      fileText: string;
      fileName: string;
      /** A sealed fit check (lib/fit/token.ts), when the draft follows one. */
      assessment: string | null;
    }
  | { ok: false; response: Response };

export async function readJobSubmission(req: Request, userId: string): Promise<JobSubmission> {
  // Two transports, one endpoint. A file can only arrive as multipart, but everything
  // that posts JSON keeps working untouched — the branch is on what the request actually
  // says it is, not on a new route.
  const isMultipart = (req.headers.get('content-type') ?? '')
    .toLowerCase()
    .includes('multipart/form-data');

  let jobInput = '';
  let fileText = '';
  let fileName = '';
  let assessment: string | null = null;

  if (isMultipart) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return refuse({
        problem: 'empty',
        message: 'That upload could not be read. Try attaching the file again.',
        status: 400,
      });
    }

    const typed = form.get('jobInput');
    jobInput = typeof typed === 'string' ? typed.trim() : '';
    const sealed = form.get('assessment');
    assessment = typeof sealed === 'string' && sealed ? sealed : null;

    const file = form.get('jobFile');
    if (file instanceof File && file.size > 0) {
      // The browser's declared type is a hint, never the decision: the extension and
      // the MIME type are both checked here, and the size cap is re-enforced on this
      // side because the input's `accept` attribute stops nothing that is not a browser.
      if (file.size > MAX_UPLOAD_BYTES) {
        return refuse(
          fileRejection('file-too-big', { sizeBytes: file.size, maxBytes: MAX_UPLOAD_BYTES }),
        );
      }

      const format = formatFromFile(file.name, file.type);
      if (!format) return refuse(fileRejection('file-type'));

      try {
        // Read into memory, use the text, let the bytes go. Nothing is written to disk
        // or to any store, exactly as the importer promises for the same file types.
        const buffer = Buffer.from(await file.arrayBuffer());
        const extracted = await extractUploadText(buffer, format);
        if (!hasReadableText(extracted.text)) return refuse(unreadableFileMessage(format));
        fileText = extracted.text;
        fileName = file.name;
      } catch (err) {
        // `UnsafeUploadError` messages are written for the person who chose the file —
        // "that DOCX expands to far more than a document should" tells them what to do
        // next. Anything else here is a library's internals: mammoth and pdf-parse
        // describe their own structures, and a decompression guard is exactly the
        // surface where an attacker probes with malformed input to see what the parser
        // says back.
        if (!(err instanceof UnsafeUploadError)) {
          console.error('[job-submission] job file could not be read for user', userId, err);
        }
        return refuse({
          problem: 'file-unreadable',
          message:
            err instanceof UnsafeUploadError
              ? `Could not read that file: ${err.message}`
              : 'That file could not be read. If it is a PDF, make sure it is not a scan; otherwise try a DOCX, or paste the text instead.',
          status: 422,
        });
      }
    } else if (file instanceof File) {
      return refuse(fileRejection('file-empty'));
    }
  } else {
    const read = await readJsonLimited(req, JSON_MAX_BYTES);
    if (!read.ok) return { ok: false, response: read.res };
    const body = (read.value && typeof read.value === 'object' ? read.value : {}) as {
      jobInput?: unknown;
      assessment?: unknown;
    };
    jobInput = typeof body.jobInput === 'string' ? body.jobInput.trim() : '';
    assessment = typeof body.assessment === 'string' && body.assessment ? body.assessment : null;
  }

  // A draft that follows a fit check carries its job inside the seal; there is no text to
  // validate, and no posting to read again.
  if (!assessment) {
    const rejection = validateJobSubmission(jobInput, fileText.length);
    if (rejection) return refuse(rejection);
  }

  return { ok: true, jobInput, fileText, fileName, assessment };
}

function refuse(rejection: JobInputRejection): { ok: false; response: Response } {
  return { ok: false, response: jsonError(rejection.message, rejection.status) };
}

export function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
