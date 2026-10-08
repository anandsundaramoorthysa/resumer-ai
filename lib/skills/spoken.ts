/**
 * Spoken (human) languages, told apart from programming languages.
 *
 * An importer reads "Languages: English, Hindi, Tamil" and files each as a skill of
 * category 'language' — the same category as Python — so a draft printed "Programming
 * Languages: Python, English". The lexicon below is what keeps them apart, applied where
 * they are written (the importer) and where they are printed (the renderer), so rows that
 * were stored before this existed print correctly too. No stored data changes.
 */

/** canonical English name -> every spelling worth recognising (English + native script). */
const SPOKEN: Record<string, string[]> = {
  English: ['english', 'इंग्लिश', 'अंग्रेज़ी', 'अंग्रेजी', 'ஆங்கிலம்', 'ఇంగ్లీష్', 'ಇಂಗ್ಲಿಷ್', 'ഇംഗ്ലീഷ്'],
  Hindi: ['hindi', 'हिन्दी', 'हिंदी', 'ஹிந்தி'],
  Tamil: ['tamil', 'தமிழ்', 'तमिल', 'तमिळ'],
  Telugu: ['telugu', 'తెలుగు', 'तेलुगु', 'தெலுங்கு'],
  Kannada: ['kannada', 'ಕನ್ನಡ', 'कन्नड', 'கன்னடம்'],
  Malayalam: ['malayalam', 'മലയാളം', 'मलयालम', 'மலையாளம்'],
  Marathi: ['marathi', 'मराठी', 'மராத்தி'],
  Bengali: ['bengali', 'bangla', 'বাংলা', 'बंगाली', 'வங்காளம்'],
  Gujarati: ['gujarati', 'ગુજરાતી', 'गुजराती'],
  Punjabi: ['punjabi', 'panjabi', 'ਪੰਜਾਬੀ', 'पंजाबी'],
  Urdu: ['urdu', 'اردو', 'उर्दू'],
  Odia: ['odia', 'oriya', 'ଓଡ଼ିଆ', 'ओड़िया', 'ओडिया'],
};

const BY_SPELLING = new Map<string, string>();
for (const [canonical, spellings] of Object.entries(SPOKEN)) {
  for (const s of spellings) BY_SPELLING.set(s.normalize('NFC').toLowerCase(), canonical);
}

/** The canonical English name when `name` is a spoken language ("हिन्दी (Native)" -> "Hindi"), else null. */
export function spokenLanguage(name: string | null | undefined): string | null {
  const key = (name ?? '')
    .normalize('NFC')
    .replace(/\s*[(\[].*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return key ? (BY_SPELLING.get(key) ?? null) : null;
}

export const isSpokenLanguage = (name: string | null | undefined): boolean => spokenLanguage(name) !== null;
