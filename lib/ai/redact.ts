/**
 * Contact details out of text that is about to go to a model.
 *
 * A cover letter or an interview-prep prompt needs the person's experience, not their
 * inbox. Replace the identifiers with placeholders before the call and put the real ones
 * back (or never need them) afterwards.
 *
 * Input is NFKC-normalised first (full-width digits and "＠" fold to ASCII; Indic digits are
 * mapped by hand, NFKC leaves them alone), so the output is the normalised text. The
 * matching is deliberately conservative: years ("2024-2026"), versions ("v1.2.3"), amounts
 * ("10,00,000") and short numbers are left alone. It is a best-effort filter, not a
 * guarantee: free text can always hide an identifier in a form no regex anticipates.
 */

// Zero code points of the decimal digit blocks used in India and neighbours.
const DIGIT_ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66];
const NATIVE_DIGIT = new RegExp(`[${DIGIT_ZEROS.map((z) => `\\u${z.toString(16).padStart(4, '0')}-\\u${(z + 9).toString(16).padStart(4, '0')}`).join('')}]`, 'g');
const asciiDigits = (s: string) =>
  s.replace(NATIVE_DIGIT, (ch) => {
    const cp = ch.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9)!;
    return String(cp - zero);
  });

// john@gmail.com, and "john@gmail .com" (a stray space before the last dots).
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\s?\.[A-Z]{2,}/gi;
const AT_BRACKET = String.raw`\s*[\[(]\s*at\s*[\])]\s*`;
const DOT_WORD = String.raw`(?:\s*[\[(]\s*dot\s*[\])]\s*|\s+dot\s+)`;
// john [at] gmail [dot] com, john(at)gmail.com
const OBF_BRACKET = new RegExp(String.raw`[A-Z0-9._%+-]+${AT_BRACKET}[A-Z][A-Z0-9-]*(?:(?:${DOT_WORD}|\.)[A-Z0-9-]+)+(?<=[A-Z]{2})\b`, 'gi');
// john at gmail dot com: a bare " at " needs spelled-out dots too, so "joined at stripe.com" is left alone.
const OBF_PLAIN = new RegExp(String.raw`[A-Z0-9._%+-]+\s+at\s+[A-Z][A-Z0-9-]*(?:${DOT_WORD}[A-Z0-9-]+)+(?<=[A-Z]{2})\b`, 'gi');

// A run of digits and phone punctuation holding 10-15 digits (the E.164 maximum), with an
// optional extension: +91 98765 43210, 0091 98765 43210, (+91) 98765 43210, 9876543210x12,
// (555) 123-4567. Years, scores and counts are far shorter.
const PHONE_RUN = /(?<![\w.])[+(]{0,2}\d[\d\s().-]{8,22}\d(?:\s?(?:x|ext\.?|extension)\s?\d{1,5})?(?![\w])/gi;
const digits = (s: string) => s.replace(/\D/g, '').length;
function isPhone(m: string): boolean {
  const n = digits(m.replace(/(?:x|ext\.?|extension)\s?\d{1,5}$/i, ''));
  if (n < 10 || n > 15) return false;
  const tokens = m.split(/[\s().-]+/).filter(Boolean);
  if (tokens.filter((t) => /^(?:19|20)\d\d$/.test(t)).length >= 2) return false; // "2020-2022 2023"
  if (/^\d+(?:\.\d+){3,}$/.test(m)) return false; // 1.2.3.4.5.6.7.8.9.10: a version or an address
  return true;
}

const PROFILE_URL = new RegExp(
  [
    String.raw`(?<![\w-])(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:linkedin\.com\/(?:in|pub)|github\.com|gitlab\.com|(?:x|twitter)\.com|leetcode\.com\/(?:u\/)?|kaggle\.com|codeforces\.com\/profile|hackerrank\.com\/(?:profile\/)?|medium\.com\/@?)\/?[A-Za-z0-9_%.-]+\/?`,
    String.raw`(?<![\w-])(?:https?:\/\/)?[a-z0-9-]+\.(?:github|gitlab)\.io(?:\/[A-Za-z0-9_%./-]*)?`,
  ].join('|'),
  'gi',
);

export function redactContact(text: string, opts: { profileUrls?: boolean } = {}): string {
  let out = asciiDigits(text.normalize('NFKC'))
    .replace(OBF_BRACKET, '[email]')
    .replace(OBF_PLAIN, '[email]')
    .replace(EMAIL, '[email]')
    .replace(PHONE_RUN, (m) => (isPhone(m) ? '[phone]' : m));
  if (opts.profileUrls !== false) out = out.replace(PROFILE_URL, '[profile-url]');
  return out;
}
