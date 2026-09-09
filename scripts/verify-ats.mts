/**
 * ATS copy-paste integrity for a generated resume.
 *
 * A resume can look perfect and still fail the only reader that matters first. This
 * pulls the text back out of the PDF exactly the way the importer does — the same
 * extractor an applicant tracking system would use — and asks whether the words
 * survived: no word split across a line by a hyphen, no two words glued together, the
 * job's keywords still findable as whole strings, contact details still parseable, and
 * every section heading still on a line of its own.
 *
 * The hyphen check exists because @react-pdf hyphenated at line ends and shipped
 * "produc-tion-grade" and "bench-marked" into real resumes, where a keyword filter
 * looking for "production" finds nothing.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/verify-ats.mts <resume.pdf>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extractUploadText } from '../lib/import/text';

const file = process.argv[2];
if (!file) {
  console.error('usage: verify-ats.mts <resume.pdf>');
  process.exit(1);
}

const { text } = await extractUploadText(readFileSync(file), 'pdf');
writeFileSync(file.replace(/\.pdf$/i, '') + '-extracted.txt', text);
console.log('extracted chars:', text.length);

// 1. Hyphenation damage — the defect registerHyphenationCallback was added to prevent.
const hyphenSplit = [...text.matchAll(/([A-Za-z]{2,})-\s*\n?\s*([a-z]{2,})/g)].map((m) =>
  m[0].replace(/\s+/g, ''),
);
console.log('\nmid-word hyphen breaks:', hyphenSplit.length);
for (const h of hyphenSplit.slice(0, 10)) console.log('   ', h);

// 2. Words glued together across a line break (the other copy-paste failure).
const glued = [...text.matchAll(/\b[a-z]{3,}[A-Z][a-z]{3,}\b/g)].map((m) => m[0]);
console.log('\nsuspicious glued words:', glued.length, glued.slice(0, 8).join(', '));

// 3. Do the job's keywords survive as whole, searchable strings?
const KEYWORDS = [
  'Python',
  'SQL',
  'pandas',
  'scikit-learn',
  'TensorFlow',
  'Docker',
  'Git',
  'REST',
  'machine learning',
  'data',
  'model',
];
console.log('\nkeyword survives copy-paste:');
for (const k of KEYWORDS) {
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(escaped, 'i').test(text);
  console.log(`  ${found ? 'yes' : 'NO '}  ${k}`);
}

// 4. Contact details must survive as parseable strings.
const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text);
const phone = /\+?\d[\d ()-]{7,}\d/.exec(text);
console.log('\nemail parsed:', email?.[0] ?? 'NONE');
console.log('phone parsed:', phone?.[0]?.trim() ?? 'NONE');
console.log('linkedin present:', /linkedin\.com/i.test(text));
console.log('github present:', /github\.com/i.test(text));

// 5. Section headings must come through as their own lines, which is how a parser
//    decides where experience stops and education starts.
const HEADINGS = ['Summary', 'Skills', 'Experience', 'Education', 'Projects', 'Certifications'];
console.log('\nheadings found on their own line:');
const lines = text.split('\n').map((l) => l.trim());
for (const h of HEADINGS) {
  console.log(`  ${lines.some((l) => l.toLowerCase() === h.toLowerCase()) ? 'yes' : 'no '}  ${h}`);
}
