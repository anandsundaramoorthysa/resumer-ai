/**
 * Attaching a job description file to a draft — the deterministic half.
 *
 * Reading a PDF is lib/import/text's job and is already covered; what is new here is
 * everything that decides whether a submission is usable and how two halves become one
 * job text. Those decisions are what the user meets as an error message or as a wrong
 * draft, and none of them needs a provider key to check.
 */

import { assert, report, suite, test } from './harness.mjs';
import {
  JOB_FILE_ACCEPT,
  MAX_JOB_FILE_BYTES,
  MAX_JOB_INPUT_CHARS,
  combineJobText,
  fileRejection,
  hasReadableText,
  isAcceptedJobFile,
  unreadableFileMessage,
  validateJobSubmission,
} from '@/lib/intake/job-input';
import { MAX_TEXT_CHARS, MAX_UPLOAD_BYTES, formatFromFile } from '@/lib/import/text';
import { looksLikeUrl } from '@/lib/intake/scrape';

/* ------------------------------------------------- limits stay in step ---- */

suite('client-side copies of the server limits', () => {
  // lib/intake/job-input restates these so the client component can import them
  // without dragging pdf-parse into the browser bundle. If the real limits move and
  // these do not, the browser starts promising something the server refuses.
  test('the char ceiling matches lib/import/text', () => {
    assert.equal(MAX_JOB_INPUT_CHARS, MAX_TEXT_CHARS);
  });

  test('the byte ceiling matches lib/import/text', () => {
    assert.equal(MAX_JOB_FILE_BYTES, MAX_UPLOAD_BYTES);
  });

  test('the browser accepts exactly what the server can read', () => {
    const cases: [string, string][] = [
      ['jd.pdf', 'application/pdf'],
      ['jd.PDF', ''],
      ['jd.docx', ''],
      ['upload', 'application/pdf'],
      [
        'upload',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      ['jd.doc', 'application/msword'],
      ['jd.txt', 'text/plain'],
      ['jd.pages', ''],
      ['jd.png', 'image/png'],
    ];
    for (const [name, type] of cases) {
      assert.equal(
        isAcceptedJobFile(name, type),
        formatFromFile(name, type) !== null,
        `${name} (${type}) disagrees with the server`,
      );
    }
  });

  test('the accept attribute names both formats and both MIME types', () => {
    for (const part of [
      '.pdf',
      '.docx',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]) {
      assert.ok(JOB_FILE_ACCEPT.includes(part), `accept is missing ${part}`);
    }
  });
});

/* ----------------------------------------------------------- validation --- */

suite('what may be submitted', () => {
  test('nothing at all is refused, and says either half is enough', () => {
    const r = validateJobSubmission('', 0);
    assert.equal(r?.problem, 'empty');
    assert.equal(r?.status, 400);
    assert.match(r!.message, /attach/i);
  });

  test('whitespace is nothing at all', () => {
    assert.equal(validateJobSubmission('   \n\t ', 0)?.problem, 'empty');
  });

  test('typed text under three characters is still refused', () => {
    assert.equal(validateJobSubmission('ab', 0)?.problem, 'too-short');
    assert.equal(validateJobSubmission('abc', 0), null);
  });

  test('a file alone clears the floor with no typed text', () => {
    assert.equal(validateJobSubmission('', 4_000), null);
  });

  test('a one-character note plus a real document is fine', () => {
    assert.equal(validateJobSubmission('x', 4_000), null);
  });

  test('the floor counts both halves together', () => {
    assert.equal(validateJobSubmission('ab', 1), null);
    assert.equal(validateJobSubmission('a', 1)?.problem, 'too-short');
  });
});

suite('file refusals name the file problem, not a generic failure', () => {
  test('a disallowed type says which types work and offers pasting', () => {
    const r = fileRejection('file-type');
    assert.equal(r.status, 415);
    assert.match(r.message, /PDF and DOCX/);
    assert.match(r.message, /paste/i);
  });

  test('an oversized file states its size and the cap', () => {
    const r = fileRejection('file-too-big', {
      sizeBytes: 12.5 * 1024 * 1024,
      maxBytes: MAX_JOB_FILE_BYTES,
    });
    assert.equal(r.status, 413);
    assert.match(r.message, /12\.5 MB/);
    assert.match(r.message, /limit is 8 MB/);
  });

  test('an empty file is its own message', () => {
    assert.equal(fileRejection('file-empty').status, 400);
  });

  test('a scanned PDF is told what to do about it', () => {
    const r = unreadableFileMessage('pdf');
    assert.equal(r.status, 422);
    assert.match(r.message, /scan|photo/i);
    assert.match(r.message, /DOCX|paste/i);
    assert.notEqual(r.message, unreadableFileMessage('docx').message);
  });

  test('a page of scanner noise counts as no text layer', () => {
    assert.equal(hasReadableText('   \n  Page 1 of 3  \n '), false);
    assert.equal(hasReadableText('x'.repeat(119)), false);
    assert.equal(hasReadableText('x'.repeat(120)), true);
    // Whitespace is not content: 200 spaces around 5 letters is still a scan.
    assert.equal(hasReadableText(`${' '.repeat(400)}hello`), false);
  });
});

/* ------------------------------------------------------------ combining --- */

suite('combining typed text and file text', () => {
  test('typed text alone is returned untouched', () => {
    const out = combineJobText('Senior SEO Analyst at Acme', '');
    assert.equal(out.text, 'Senior SEO Analyst at Acme');
    assert.equal(out.truncated, false);
  });

  test('a bare URL alone is left scrapable — nothing is wrapped around it', () => {
    const url = 'https://example.com/jobs/123';
    const out = combineJobText(url, '');
    assert.equal(out.text, url);
    assert.ok(looksLikeUrl(out.text), 'a decorated URL would stop being scraped');
  });

  test('file text alone is labelled as an attachment', () => {
    const out = combineJobText('', 'We are hiring an SEO analyst.', 'jd.pdf');
    assert.match(out.text, /^--- Attached job description: jd\.pdf ---\n/);
    assert.ok(out.text.includes('We are hiring an SEO analyst.'));
  });

  test('the label survives a file with no name', () => {
    const out = combineJobText('', 'Body text');
    assert.equal(out.text, '--- Attached job description ---\nBody text');
  });

  test('both halves appear, typed first, document fenced and named', () => {
    const out = combineJobText('Focus on the AI team.', 'Full posting body.', 'jd.docx');
    assert.equal(
      out.text,
      'Focus on the AI team.\n\n--- Attached job description: jd.docx ---\nFull posting body.',
    );
    assert.equal(out.truncated, false);
    assert.ok(
      out.text.indexOf('Focus on the AI team.') <
        out.text.indexOf('Full posting body.'),
      'the typed note must lead',
    );
  });

  test('a scraped page and a file both survive into one input', () => {
    // This is the URL-plus-file case: the pipeline has already scraped, so the page
    // text arrives as the primary half and neither side is thrown away.
    const out = combineJobText('SCRAPED PAGE TEXT', 'ATTACHED PDF TEXT', 'jd.pdf');
    assert.ok(out.text.includes('SCRAPED PAGE TEXT'));
    assert.ok(out.text.includes('ATTACHED PDF TEXT'));
  });

  test('surrounding whitespace on either half is trimmed away', () => {
    const out = combineJobText('  note  ', '\n\ndoc\n\n', 'a.pdf');
    assert.equal(out.text, 'note\n\n--- Attached job description: a.pdf ---\ndoc');
  });

  test('the combined text never exceeds the ceiling', () => {
    const out = combineJobText('note', 'x'.repeat(MAX_JOB_INPUT_CHARS * 2), 'big.pdf');
    assert.ok(out.text.length <= MAX_JOB_INPUT_CHARS);
    assert.equal(out.truncated, true);
    assert.ok(out.text.startsWith('note'), 'the typed half must not be the part cut');
  });

  test('a document alone is cut to the ceiling', () => {
    const out = combineJobText('', 'x'.repeat(MAX_JOB_INPUT_CHARS * 2), 'big.pdf');
    assert.equal(out.text.length, MAX_JOB_INPUT_CHARS);
    assert.equal(out.truncated, true);
  });

  test('typed text long enough to fill the budget alone keeps the budget', () => {
    const typed = 'y'.repeat(MAX_JOB_INPUT_CHARS + 500);
    const out = combineJobText(typed, 'attached', 'a.pdf');
    assert.equal(out.text.length, MAX_JOB_INPUT_CHARS);
    assert.equal(out.truncated, true);
    assert.equal(out.text, 'y'.repeat(MAX_JOB_INPUT_CHARS));
  });

  test('an over-long typed half with no file is cut, not silently kept', () => {
    const out = combineJobText('z'.repeat(MAX_JOB_INPUT_CHARS + 1), '');
    assert.equal(out.text.length, MAX_JOB_INPUT_CHARS);
    assert.equal(out.truncated, true);
  });

  test('the cap is a parameter, so the rule can be checked at any size', () => {
    const out = combineJobText('ab', 'cdefghijklmnop', 'f.pdf', 50);
    assert.ok(out.text.length <= 50);
    assert.equal(out.truncated, true);
    assert.ok(out.text.startsWith('ab\n\n--- Attached job description: f.pdf ---\n'));
  });
});

report('draft-file');
