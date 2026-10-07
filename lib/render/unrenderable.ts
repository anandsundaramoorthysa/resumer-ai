/**
 * Emoji and pictographs: no embedded font draws them, and an unmapped character prints as a
 * box. They are removed (with the joiners and variation selectors that belong to them)
 * rather than shipped as tofu. © ® ™ are pictographic by the Unicode tables but are ordinary
 * text and Noto Sans has them, so they stay.
 */
const PICTOGRAPH =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3](?:[\ufe0e\ufe0f\u{1f3fb}-\u{1f3ff}]|\u200d[\p{Extended_Pictographic}])*/gu;
const KEEP = new Set(['©', '®', '™']);

export function stripUnrenderable(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = text
    .replace(PICTOGRAPH, (m) => {
      if (KEEP.has(m)) return m;
      removed += 1;
      return '';
    })
    // A leftover joiner or selector with no emoji to belong to.
    .replace(/[\ufe0e\ufe0f]/g, '');
  // Closing the gap an emoji left, only where one was removed: other spacing is the author's.
  if (removed > 0) out = out.replace(/ {2,}/g, ' ').trim();
  return { text: out, removed };
}
