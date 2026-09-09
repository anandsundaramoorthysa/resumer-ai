/**
 * Job input assembly — what the draft is actually started from.
 *
 * A draft can be started from typed text (a link, a pasted description, a LinkedIn
 * post), from an attached PDF/DOCX, or from both at once. Everything that decides
 * whether a submission is usable, and how the two halves become one job text, lives
 * here so it is pure and testable — the route and the pipeline only call into it.
 */

/*
 * The two limits below deliberately restate `MAX_TEXT_CHARS` and `MAX_UPLOAD_BYTES`
 * from lib/import/text rather than importing them: that module pulls in pdf-parse and
 * mammoth, which cannot be bundled into the client component that needs these numbers
 * to warn about a too-large file before uploading it. lib/import/text remains the
 * source of truth — the server enforces its constants, and tests/draft-file.test.mts
 * asserts these copies still match it.
 */

/** The combined job text is fed to the same extractor the importer feeds, so it obeys
 *  the same ceiling. */
export const MAX_JOB_INPUT_CHARS = 40_000;

/** Mirrors MAX_UPLOAD_BYTES: 8 MB. */
export const MAX_JOB_FILE_BYTES = 8 * 1024 * 1024;

/** The `accept` attribute, identical to the importer's file picker. */
export const JOB_FILE_ACCEPT =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * A client-side mirror of `formatFromFile` — the browser can say "that is not a PDF"
 * instantly instead of after an 8 MB upload. It is a courtesy, never the gate: the
 * server re-derives the format from the bytes' own name and MIME and refuses there.
 */
export function isAcceptedJobFile(name: string, mimeType: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.pdf') ||
    lower.endsWith('.docx') ||
    mimeType === 'application/pdf' ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

export type JobInputProblem =
  | 'empty'
  | 'too-short'
  | 'file-empty'
  | 'file-type'
  | 'file-too-big'
  | 'file-unreadable';

export interface JobInputRejection {
  problem: JobInputProblem;
  message: string;
  status: number;
}

/**
 * Nothing at all, and not-quite-enough, are different mistakes and get different
 * sentences: one means "you forgot", the other means "what you gave is too thin".
 * `typedText` is the text the user typed; `fileChars` is how much readable text came
 * out of the attachment (0 when there is no attachment).
 */
export function validateJobSubmission(
  typedText: string,
  fileChars: number,
): JobInputRejection | null {
  const typed = typedText.trim();

  if (typed.length === 0 && fileChars === 0) {
    return {
      problem: 'empty',
      message:
        'Paste a job link or description, or attach the job description as a PDF or DOCX. Either one on its own is enough.',
      status: 400,
    };
  }

  // The three-character floor is the pre-existing rule, now applied to everything
  // supplied rather than to the textarea alone — a one-character note plus a real
  // document is fine, and a two-character note on its own still is not.
  if (typed.length + fileChars < 3) {
    return {
      problem: 'too-short',
      message:
        'There is not enough here to draft against. Paste the posting, a link to it, or attach a file that contains the details.',
      status: 400,
    };
  }

  return null;
}

/** The user-visible sentence for each way an attached file can be refused. Kept beside
 *  the other job-input decisions, and worded the way /import words the same refusals. */
export function fileRejection(
  problem: Extract<JobInputProblem, 'file-empty' | 'file-type' | 'file-too-big'>,
  detail?: { sizeBytes?: number; maxBytes?: number },
): JobInputRejection {
  if (problem === 'file-empty') {
    return { problem, message: 'That file is empty.', status: 400 };
  }
  if (problem === 'file-type') {
    return {
      problem,
      message:
        'Only PDF and DOCX files can be read. Save the job description as one of those, or paste its text instead.',
      status: 415,
    };
  }
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
  return {
    problem,
    message: `That file is ${mb(detail?.sizeBytes ?? 0)} MB. The limit is ${mb(
      detail?.maxBytes ?? 0,
    )} MB — a job description is normally well under 1 MB.`,
    status: 413,
  };
}

/**
 * A PDF that is a photograph or a scan extracts to almost nothing. Saying so, and
 * saying what to do instead, is the same answer /import gives for the same file.
 */
export function unreadableFileMessage(format: 'pdf' | 'docx'): JobInputRejection {
  return {
    problem: 'file-unreadable',
    message:
      format === 'pdf'
        ? 'That PDF has no readable text layer — it looks like a scan or a photo. Attach the original PDF or a DOCX version, or paste the posting text instead.'
        : 'That DOCX contained almost no text. Attach the original, or paste the posting text instead.',
    status: 422,
  };
}

/** A file whose text is shorter than this is treated as having no text layer. */
export const MIN_FILE_TEXT_CHARS = 120;

export function hasReadableText(text: string): boolean {
  return text.replace(/\s+/g, '').length >= MIN_FILE_TEXT_CHARS;
}

export interface CombinedJobText {
  text: string;
  truncated: boolean;
}

/**
 * Merges the typed half and the attached half into the one string the job extractor
 * reads.
 *
 * The rules, and why:
 *
 * 1. Typed text alone is returned untouched — no header, no wrapper. That path has to
 *    stay byte-identical to what it was, because `looksLikeUrl` rejects anything
 *    containing whitespace: a decorated bare URL would silently stop being scraped.
 *    A file alone still gets its label, which costs nothing — an extracted document
 *    contains whitespace and so could never have been mistaken for a URL anyway.
 * 2. Typed text comes first, the document second under a labelled fence. The typed box
 *    is where the user says what they mean in this session ("this role, but the team is
 *    the AI one") while the document is bulk material; putting the short deliberate
 *    part first and naming the long part as an attachment lets the extractor treat them
 *    as what they are instead of one undifferentiated blob.
 * 3. The URL-plus-file case is not resolved here. The pipeline scrapes the typed text
 *    *before* calling this, and passes the scraped page in as `primary`, so a link and
 *    an attachment both contribute rather than one winning. That is why this function
 *    takes "primary text", not "typed text".
 * 4. Over the ceiling, the document is cut and the typed text is not: the typed text is
 *    short, hand-written and load-bearing, and the document is the part with the boiler-
 *    plate in it. Only if the typed half alone overruns is it cut at all.
 */
export function combineJobText(
  primaryText: string,
  fileText: string,
  fileName?: string,
  maxChars: number = MAX_JOB_INPUT_CHARS,
): CombinedJobText {
  const primary = primaryText.trim();
  const file = fileText.trim();

  if (!file) {
    const truncated = primary.length > maxChars;
    return { text: truncated ? primary.slice(0, maxChars) : primary, truncated };
  }

  const header = `--- Attached job description${fileName ? `: ${fileName}` : ''} ---`;

  if (!primary) {
    const body = `${header}\n${file}`;
    const truncated = body.length > maxChars;
    return { text: truncated ? body.slice(0, maxChars) : body, truncated };
  }

  const prefix = `${primary}\n\n${header}\n`;
  const room = maxChars - prefix.length;

  if (room <= 0) {
    // Only reachable when the typed text alone fills the budget. The attachment cannot
    // be represented at all, so the typed text is what survives.
    return { text: primary.slice(0, maxChars), truncated: true };
  }

  const truncated = file.length > room;
  return { text: prefix + (truncated ? file.slice(0, room) : file), truncated };
}
