/**
 * CSV parsing, to RFC 4180.
 *
 * Splitting on commas is what makes an import quietly wrong rather than loudly broken:
 * LinkedIn writes job descriptions into `Positions.csv`, and a description contains
 * commas, quotation marks and newlines as a matter of course. A naive split turns one
 * job into six malformed ones, and nothing about the result looks like a parse failure.
 *
 * So this is a character-level reader: quoted fields may contain anything, a doubled
 * quote inside a quoted field is a literal quote, and CRLF, CR and LF all end a row.
 */

export type CsvRow = Record<string, string>;

/** Rows as raw arrays, before headers are applied. */
export function parseCsvRows(text: string): string[][] {
  // A UTF-8 BOM would otherwise become part of the first header name, so the first
  // column silently fails to match — a failure mode with no visible symptom.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (c === ',') {
      endField();
      started = true;
    } else if (c === '\r') {
      if (input[i + 1] === '\n') i++;
      endRow();
    } else if (c === '\n') {
      endRow();
    } else {
      field += c;
      started = true;
    }
  }

  // A trailing newline must not produce a phantom empty row.
  if (started || field !== '' || row.length > 0) endRow();

  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/**
 * Rows keyed by header.
 *
 * Header names are normalised because the export is not consistent about them across
 * sections or over time — "Started On" and "Start Date" both appear, and casing varies.
 * Callers look values up through `pick()` rather than by exact string.
 */
export function parseCsv(text: string): CsvRow[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((values) => {
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      if (h) row[h] = (values[i] ?? '').trim();
    });
    return row;
  });
}

export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The first of several possible column names that holds a value. */
export function pick(row: CsvRow, ...names: string[]): string {
  for (const name of names) {
    const v = row[normalizeHeader(name)];
    if (v && v.trim()) return v.trim();
  }
  return '';
}
