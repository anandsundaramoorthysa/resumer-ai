/**
 * Marks job keywords inside a piece of text.
 * matched -> <mark class="hl">; missing -> dashed brand underline + sr-only "(missing)".
 * Matching is case-insensitive, regex-escaped and word-bounded (so "C" never lights up
 * inside "React"); terms that start/end in a symbol (C++, .NET) are bounded by
 * "not a letter or digit" rather than \b.
 */

import { splitByKeywords } from './keyword-split';

export function KeywordHighlight({
  text,
  matched,
  missing = [],
}: {
  text: string;
  matched: string[];
  missing?: string[];
}) {
  return (
    <>
      {splitByKeywords(text, matched, missing).map((s, i) =>
        s.kind === 'matched' ? (
          <mark key={i} className="hl">
            {s.text}
          </mark>
        ) : s.kind === 'missing' ? (
          <span key={i} className="underline decoration-brand decoration-dashed underline-offset-4">
            {s.text}
            <span className="sr-only"> (missing)</span>
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
