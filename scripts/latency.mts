/**
 * Times one small structured call per provider.
 * Run: npx tsx scripts/latency.mts
 */

import 'dotenv/config';
import { z } from 'zod';
import { generateObject, generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createFireworks } from '@ai-sdk/fireworks';
import { availableProviders } from '../lib/ai/models';

const Schema = z.object({
  role: z.string(),
  seniority: z.string(),
  keywords: z.array(z.string()),
});

const PROMPT =
  'Extract role, seniority and 5 keywords: "Senior Technical SEO Lead at Semrush. 5+ years technical SEO, GA4, Search Console, Screaming Frog, Core Web Vitals."';

function model(id: string, m: string) {
  const key = process.env[
    { google: 'GOOGLE_GENERATIVE_AI_API_KEY', groq: 'GROQ_API_KEY', deepinfra: 'DEEPINFRA_API_KEY', togetherai: 'TOGETHER_API_KEY', fireworks: 'FIREWORKS_API_KEY' }[id]!
  ] as string;
  switch (id) {
    case 'google': return createGoogleGenerativeAI({ apiKey: key })(m);
    case 'groq': return createGroq({ apiKey: key })(m);
    case 'deepinfra': return createDeepInfra({ apiKey: key })(m);
    case 'togetherai': return createTogetherAI({ apiKey: key })(m);
    default: return createFireworks({ apiKey: key })(m);
  }
}

async function timeIt(label: string, fn: () => Promise<unknown>) {
  const t = Date.now();
  try {
    await fn();
    return { label, ms: Date.now() - t, ok: true, err: '' };
  } catch (e) {
    return { label, ms: Date.now() - t, ok: false, err: (e as Error).message.slice(0, 70) };
  }
}

const rows: Array<{ label: string; ms: number; ok: boolean; err: string }> = [];

for (const p of availableProviders()) {
  for (const tier of ['standard', 'fast'] as const) {
    const m = tier === 'fast' ? p.fastModel : p.model;
    rows.push(
      await timeIt(`${p.label} [${tier}] schema`, () =>
        generateObject({ model: model(p.id, m), schema: Schema, prompt: PROMPT, temperature: 0.1, maxRetries: 0 }),
      ),
    );
    rows.push(
      await timeIt(`${p.label} [${tier}] text`, () =>
        generateText({ model: model(p.id, m), prompt: PROMPT, temperature: 0.1, maxRetries: 0 }),
      ),
    );
  }
}

console.log('\n  provider / mode                          time     result');
console.log('  ' + '-'.repeat(62));
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(38)} ${String(r.ms + 'ms').padStart(7)}   ${r.ok ? 'ok' : 'FAIL ' + r.err}`,
  );
}
const okRows = rows.filter((r) => r.ok);
if (okRows.length) {
  const fastest = okRows.reduce((a, b) => (a.ms < b.ms ? a : b));
  console.log(`\n  fastest working: ${fastest.label} at ${fastest.ms}ms\n`);
}
