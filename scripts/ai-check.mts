/**
 * Verifies the AI provider chain against whatever keys are in .env.
 * Run:  npx tsx scripts/ai-check.mts
 */

import 'dotenv/config';
import { availableProviders } from '../lib/ai/models';
import { extractJobRequirement } from '../lib/intake/extract';
import { DraftBudget } from '../lib/ai/budget';

const SAMPLE_JD = `Technical SEO Lead — Semrush (Remote, India)

We're looking for a senior technical SEO lead to own organic growth for our product
sites. You'll run site audits, fix crawl and indexation issues, own Core Web Vitals
work with the engineering team, and report on organic traffic and rankings monthly.

Requirements: 5+ years in technical SEO, deep experience with Google Analytics 4 and
Search Console, hands-on with Screaming Frog or Sitebulb, comfortable reading HTML/JS,
schema markup, and working with developers on Core Web Vitals.
Nice to have: content strategy experience, basic SQL.`;

async function main() {
  const providers = availableProviders();
  console.log(`\nConfigured providers (in routing order): ${providers.map((p) => p.label).join(' → ') || 'NONE'}\n`);

  if (providers.length === 0) {
    console.log('No API keys found. Add at least one to .env.');
    process.exit(1);
  }

  const budget = new DraftBudget();
  const started = Date.now();

  const job = await extractJobRequirement(SAMPLE_JD, budget);

  console.log(`Extracted in ${Date.now() - started}ms using ${budget.snapshot().calls} call(s), ${budget.snapshot().tokens} tokens\n`);
  console.log('  role       :', job.roleTitle);
  console.log('  company    :', job.company ?? '—');
  console.log('  seniority  :', job.seniority);
  console.log('  category   :', job.category);
  console.log('  confidence :', job.confidence.toFixed(2));
  console.log('  required   :', job.requiredSkills.join(', '));
  console.log('  ATS keywords:', job.atsKeywords.join(', '));
  if (job.flags.length) console.log('  flags      :', job.flags.join(' | '));

  console.log('\n✓ Provider chain works end to end.\n');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message, '\n');
  process.exit(1);
});
