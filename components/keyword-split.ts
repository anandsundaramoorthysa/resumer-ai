/**
 * Pure matching helper behind KeywordHighlight (kept free of JSX so tests can import it).
 * Case-insensitive, regex-escaped, word-bounded; symbol terms (C++, .NET) are bounded by
 * "not a letter or digit" rather than a word-boundary escape.
 */

export type Segment = { text: string; kind: 'plain' | 'matched' | 'missing' };

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitByKeywords(text: string, matched: string[], missing: string[] = []): Segment[] {
  const kindOf = new Map<string, 'matched' | 'missing'>();
  for (const t of missing) if (t.trim()) kindOf.set(t.trim().toLowerCase(), 'missing');
  // Matched wins if a term is in both lists.
  for (const t of matched) if (t.trim()) kindOf.set(t.trim().toLowerCase(), 'matched');
  if (kindOf.size === 0) return [{ text, kind: 'plain' }];

  // Longest first so "React Native" beats "React".
  const terms = [...kindOf.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu');

  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), kind: 'plain' });
    out.push({ text: m[0], kind: kindOf.get(m[0].toLowerCase()) ?? 'plain' });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' });
  return out;
}
