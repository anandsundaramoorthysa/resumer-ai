/**
 * The end-to-end proof: a real resume, from the real profile, against a real posting.
 *
 * Everything else verifies a part. This runs the whole pipeline the app runs — intake,
 * retrieval, grounded rewrite, the quality-gate loop, rendering, and the ATS round-trip
 * — and prints what an ATS would actually read back out of the file.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-draft.mts
 */

import 'dotenv/config';
import postgres from 'postgres';
import { loadProfileForUser } from '../lib/server/profile';
import { runDraftPipeline } from '../lib/pipeline/run';
import { extractTextFromDocx } from '../lib/render/selftest';

const JOB = `Technical SEO Lead — Semrush (Remote, India)

We're looking for a senior technical SEO lead to own organic growth for our product
sites. You'll run site audits, fix crawl and indexation issues, own Core Web Vitals
work with the engineering team, and report on organic traffic and rankings monthly.

Requirements: 5+ years in technical SEO, deep experience with Google Analytics 4 and
Search Console, hands-on with Screaming Frog or Sitebulb, comfortable reading HTML/JS,
schema markup, and working with developers on Core Web Vitals.
Nice to have: content strategy experience, basic SQL.`;

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const [u] = await sql`select id from "user" limit 1`;
await sql.end();

const profile = await loadProfileForUser(u.id);
console.log(
  `profile loaded: ${profile.records.length} records, ${profile.roles.length} roles, contact "${profile.contact.fullName}"\n`,
);

const started = Date.now();

const result = await runDraftPipeline(
  {
    userId: u.id,
    contact: profile.contact,
    records: profile.records,
    roles: profile.roles,
    jobInput: JOB,
  },
  (e) => {
    const mark = e.status === 'done' ? '✓' : e.status === 'error' ? '!' : '·';
    console.log(`  ${mark} [${e.stage}] ${e.message}`);
  },
);

console.log(`\n--- finished in ${((Date.now() - started) / 1000).toFixed(1)}s ---\n`);

const s = result.score;
console.log(`SCORE ${s.overall.toFixed(1)}/10  ${s.passed ? 'PASSED' : 'did not clear 8.5'}`);
console.log(`  keyword gate : ${(s.keywordCoveragePct * 100).toFixed(0)}% ${s.keywordGatePassed ? '(passed)' : '(FAILED)'}`);
console.log(`  formatting   : ${(s.formattingScore * 100).toFixed(0)}%`);
console.log(`  evidence     : ${(s.evidenceScore * 100).toFixed(0)}%`);
console.log(`  skills       : ${(s.skillsCompletenessScore * 100).toFixed(0)}%`);
console.log(`  iterations   : ${s.iterations}`);
if (s.missingKeywords.length) console.log(`  missing      : ${s.missingKeywords.join(', ')}`);
if (s.haltExplanation) console.log(`  note         : ${s.haltExplanation}`);

console.log(`\nFILES`);
console.log(`  ${result.files.pdfName}  ${(result.files.pdf.length / 1024).toFixed(1)} KB`);
console.log(`  ${result.files.docxName}  ${(result.files.docx.length / 1024).toFixed(1)} KB`);
console.log(`  self-test: pdf ${result.selfTest.pdfPassed ? 'pass' : 'FAIL'}, docx ${result.selfTest.docxPassed ? 'pass' : 'FAIL'}`);
if (result.selfTest.issues.length) console.log(`  issues: ${result.selfTest.issues.join(' | ')}`);

console.log(`\nAI spend: ${result.budget.calls} calls, ${result.budget.tokens} tokens`);

console.log(`\n--- what an ATS reads out of the DOCX ---\n`);
const text = await extractTextFromDocx(result.files.docx);
console.log(text.trim());
