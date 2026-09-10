/**
 * Smoke test for everything that works without an API key.
 *
 * Covers the claims that matter most: the deterministic scorers actually catch what
 * they say they catch, the grounding guard actually rejects fabrication, and a rendered
 * PDF/DOCX actually survives being parsed back to text the way an ATS would.
 *
 * Run:  npx tsx scripts/smoke.ts
 */

import assert from 'node:assert/strict';
import type { JobRequirement, ProfileRecord, ResumeDocument } from '../lib/types';
import { scoreKeywordCoverage } from '../lib/quality/keywords';
import { scoreFormatting } from '../lib/quality/formatting';
import { scoreSkillsCompleteness } from '../lib/quality/skills';
import { findUngroundedTokens, acceptRewriteOrFallback } from '../lib/generate/grounding';
import { rankRecords } from '../lib/retrieval/rank';
import { reconcile, hashContent } from '../lib/sync/reconcile';
import { renderResumeDocx } from '../lib/render/docx';
import { selfTest } from '../lib/render/selftest';
import { resumeFileName } from '../lib/render/filename';
import { formatDate, containsNumericDate } from '../lib/render/dates';

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}

const base = {
  userId: 'u1',
  source: 'manual' as const,
  flaggedForRemoval: false,
  reviewState: 'approved' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const records: ProfileRecord[] = [
  { ...base, id: 's1', type: 'skill', name: 'PostgreSQL', category: 'tool', tags: ['postgres', 'sql', 'database'], contentHash: 'h1' },
  { ...base, id: 's2', type: 'skill', name: 'React', category: 'framework', tags: ['react', 'frontend'], contentHash: 'h2' },
  { ...base, id: 's3', type: 'skill', name: 'Google Analytics', category: 'tool', tags: ['google analytics', 'seo', 'analytics'], contentHash: 'h3' },
  {
    ...base, id: 'b1', type: 'experience-bullet', roleId: 'r1',
    text: 'Optimized PostgreSQL queries serving 200K daily requests, cutting p95 latency 40%.',
    action: 'Optimized PostgreSQL queries', scale: '200K daily requests', outcome: 'cut p95 latency 40%',
    tags: ['postgres', 'performance', 'sql'], contentHash: 'h4',
  },
  {
    ...base, id: 'b2', type: 'experience-bullet', roleId: 'r1',
    text: 'Ran technical SEO audits that lifted organic traffic 32% across 4 client sites.',
    action: 'Ran technical SEO audits', scale: '4 client sites', outcome: 'organic traffic +32%',
    tags: ['seo', 'organic traffic', 'audit'], contentHash: 'h5',
  },
];

const job: JobRequirement = {
  roleTitle: 'Technical SEO Lead', seniority: 'senior', category: 'seo',
  requiredSkills: ['Google Analytics', 'technical SEO'],
  preferredSkills: ['content strategy'],
  responsibilities: ['own organic growth'],
  atsKeywords: ['technical SEO', 'Google Analytics', 'organic traffic', 'Screaming Frog'],
  tone: 'corporate', confidence: 0.9, flags: [],
};

function doc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: 'd1', userId: 'u1',
    contact: {
      fullName: 'Anand Sundaramoorthy', email: 'anand@example.com',
      phone: '+91 90000 00000', location: 'Chennai, India',
      portfolioUrl: 'anandsundaramoorthy.com', githubUrl: 'github.com/anand',
    },
    sections: [
      { key: 'skills', heading: 'Skills', items: [{ text: 'Google Analytics, PostgreSQL, React', sourceRecordId: null }] },
      {
        key: 'experience', heading: 'Experience', items: [],
        groups: [{
          title: 'Engineer', subtitle: 'Acme', dateRange: 'Jan 2022 – Present',
          items: [
            { text: 'Ran technical SEO audits that lifted organic traffic 32% across 4 client sites.', sourceRecordId: 'b2' },
          ],
        }],
      },
    ],
    jobRequirement: job, renderMode: 'ats-strict',
    recordHashSnapshot: ['h1'], createdAt: new Date(),
    ...overrides,
  };
}

async function main() {
  console.log('\nDeterministic scorers');

  // --- keyword gate ---------------------------------------------------------
  const kw = scoreKeywordCoverage(doc());
  assert.ok(kw.matched.includes('technical SEO'), 'should match a present keyword');
  assert.ok(kw.missing.includes('Screaming Frog'), 'should report a genuinely absent keyword');
  ok(`keyword gate: ${Math.round(kw.coveragePct * 100)}% coverage, correctly flagged "Screaming Frog" as missing`);

  // --- formatting: clean doc passes ----------------------------------------
  const clean = scoreFormatting(doc());
  assert.equal(clean.violations.length, 0, `clean doc should have no violations, got: ${JSON.stringify(clean.violations)}`);
  ok('formatting: a compliant document scores 100% with zero violations');

  // --- formatting: each rule actually fires ---------------------------------
  const iconDoc = doc();
  iconDoc.sections[0].items[0].text = '📧 Google Analytics, PostgreSQL';
  assert.ok(scoreFormatting(iconDoc).violations.some((v) => v.rule === 'no-icon-glyphs'));
  ok('formatting: catches an emoji/icon glyph');

  const dateDoc = doc();
  dateDoc.sections[1].groups![0].dateRange = '01/2022 - 05/2024';
  assert.ok(scoreFormatting(dateDoc).violations.some((v) => v.rule === 'spelled-out-dates'));
  ok('formatting: catches a locale-ambiguous numeric date');

  const bulletDoc = doc();
  bulletDoc.sections[1].groups![0].items[0].text = '► Ran SEO audits';
  assert.ok(scoreFormatting(bulletDoc).violations.some((v) => v.rule === 'plain-bullet-chars'));
  ok('formatting: catches a decorative bullet character');

  const headingDoc = doc();
  headingDoc.sections[1].heading = 'My Journey';
  assert.ok(scoreFormatting(headingDoc).violations.some((v) => v.rule === 'heading-allow-list'));
  ok('formatting: rejects a non-standard section heading');

  const noSkills = doc({ sections: [doc().sections[1]] });
  assert.ok(scoreFormatting(noSkills).violations.some((v) => v.rule === 'skills-section-required'));
  ok('formatting: requires a dedicated Skills section');

  // --- skills completeness --------------------------------------------------
  const sk = scoreSkillsCompleteness(doc(), records);
  assert.ok(sk.genuineGaps.includes('Screaming Frog'), 'Screaming Frog is a real gap, not a fixable one');
  assert.ok(!sk.genuineGaps.includes('Google Analytics'), 'Google Analytics is held, so not a gap');
  ok(`skills: separated real gaps (${sk.genuineGaps.join(', ')}) from fixable omissions`);

  console.log('\nAnti-fabrication guard');

  const source = 'Optimized PostgreSQL queries serving 200K daily requests, cutting p95 latency 40%.';
  assert.equal(findUngroundedTokens('Tuned PostgreSQL queries across 200K daily requests, cutting p95 latency 40%.', source).length, 0);
  ok('accepts a faithful rephrase');

  const fabricated = findUngroundedTokens('Optimized PostgreSQL and Kubernetes queries, cutting latency 80%.', source);
  assert.ok(fabricated.some((v) => v.token === 'kubernetes'), 'should catch invented tool');
  assert.ok(
    fabricated.some((v) => v.kind === 'number' && v.token.startsWith('80')),
    'should catch invented metric',
  );
  ok(`rejects fabrication: caught ${fabricated.map((f) => f.token).join(', ')}`);

  const verdict = acceptRewriteOrFallback('Led Kubernetes migration for 500K users.', source);
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.text, source, 'must fall back to the original text');
  ok('falls back to the user\'s original wording when a rewrite invents something');

  console.log('\nRetrieval relevance floor');

  const { ranked, excluded } = rankRecords(records, job);
  const excludedIds = excluded.map((r) => r.id);
  assert.ok(excludedIds.includes('b1'), 'a Postgres-only bullet should be excluded from an SEO resume');
  assert.ok(ranked.some((r) => r.record.id === 'b2'), 'the SEO bullet should survive');
  ok(`relevance floor: kept the SEO bullet, excluded ${excluded.length} off-domain record(s) from an SEO role`);

  console.log('\nSync reconciliation');

  const existing: ProfileRecord[] = [
    { ...base, source: 'github-sync', id: 'g1', type: 'skill', name: 'React', category: 'framework', tags: ['react'], contentHash: hashContent(['skill', 'React', 'framework']) },
    { ...base, source: 'github-sync', id: 'g2', type: 'skill', name: 'Vue', category: 'framework', tags: ['vue'], contentHash: hashContent(['skill', 'Vue', 'framework']) },
    { ...base, source: 'manual', id: 'm1', type: 'skill', name: 'Handwritten', category: 'tool', tags: ['manual'], contentHash: 'manualhash' },
  ];
  const parsed = [
    { type: 'skill', name: 'React', category: 'framework', tags: ['react'], contentHash: hashContent(['skill', 'React', 'framework']) },
    { type: 'skill', name: 'Svelte', category: 'framework', tags: ['svelte'], contentHash: hashContent(['skill', 'Svelte', 'framework']) },
  ] as never;

  const plan = reconcile(existing, parsed);
  assert.equal(plan.toInsert.length, 1, 'Svelte is new');
  assert.ok(plan.toFlag.some((f) => f.id === 'g2'), 'Vue vanished from source → flagged');
  assert.ok(!plan.toFlag.some((f) => f.id === 'm1'), 'manual record must never be touched');
  assert.equal(plan.toDelete.length, 0, 'nothing is ever hard-deleted');
  ok('reconcile: added 1, flagged 1 for review, deleted 0, and left the manual record alone');

  console.log('\nRendering + ATS round-trip');

  assert.equal(formatDate('2022-01'), 'Jan 2022');
  assert.equal(formatDate('present'), 'Present');
  assert.ok(containsNumericDate('05/2024'));
  ok('dates render spelled-out and numeric forms are detectable');

  const d = doc();
  const docx = await renderResumeDocx(d);
  ok(`rendered DOCX (${(docx.length / 1024).toFixed(0)} KB)`);

  const docxTest = await selfTest(docx, 'docx', d);
  if (!docxTest.passed) console.log('    DOCX issues:', JSON.stringify(docxTest.issues, null, 2));
  assert.ok(docxTest.passed, 'DOCX must survive the round-trip');
  ok(`DOCX round-trip: ${docxTest.extractedChars} chars extracted, name/email/URLs/skills all recovered`);

  // A broken template must actually be caught, not just assumed to be.
  const brokenDoc = doc();
  brokenDoc.contact.portfolioUrl = 'anandsundaramoorthy.com';
  brokenDoc.sections[0].items[0].text = 'Skills listed only in an icon glyph: ';
  const brokenDocx = await renderResumeDocx(brokenDoc);
  const brokenTest = await selfTest(brokenDocx, 'docx', brokenDoc);
  assert.equal(brokenTest.passed, false, 'self-test must fail on a document with icon glyphs');
  ok(`self-test catches a deliberately broken template (${brokenTest.issues.filter((i) => i.severity === 'fail').map((i) => i.check).join(', ')})`);

  console.log('\n  PDF rendering is verified in the Next runtime via /api/dev/selftest');
  console.log('  (@react-pdf ships ESM-only export conditions that tsx cannot resolve).');

  assert.equal(resumeFileName(d, 'pdf'), 'Anand_Sundaramoorthy_Technical_SEO_Lead.pdf');
  ok('export filename is recruiter-friendly, not "resume_final_v2.pdf"');

  console.log(`\n${passed} checks passed.\n`);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
