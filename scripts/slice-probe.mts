/**
 * Times the REAL extraction call — full schema, real portfolio slice — per provider.
 *
 * The generic provider probe uses a toy payload and flatters everything. This one
 * answers the question the step budget actually depends on: how long does one slice of
 * this size take on each provider that works.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/slice-probe.mts [sliceChars]
 */
import 'dotenv/config';
import postgres from 'postgres';
import { PROVIDER_CHAIN } from '../lib/ai/models';

const sliceChars = process.argv[2];
if (sliceChars) process.env.SYNC_SLICE_CHARS = sliceChars;

// Imported dynamically, after the env var is set: the slice budget is read once when
// the module is evaluated, and a static import would have been hoisted above this.
const { planSlices, extractFromSlice } = await import('../lib/sync/parse');

const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',');

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const [row] = await sql<{ corpus: Array<{ path: string; content: string }> }[]>`
  select corpus from sync_job where corpus is not null order by created_at desc limit 1`;
await sql.end();
if (!row?.corpus) throw new Error('No stored corpus to probe. Run e2e-sync.mts first.');

// Only whole source files, not slices left over from a previous run's queue.
const files = row.corpus.filter((f) => !/\(\d+\/\d+\)$/.test(f.path));
const slices = planSlices(files);
const sample = [slices[0], slices[Math.floor(slices.length / 2)], slices.at(-1)!];

console.log(
  `slice budget ${process.env.SYNC_SLICE_CHARS ?? '6000'} chars — ` +
    `${slices.length} slices, sampling ${sample.length}`,
);

const keys = Object.fromEntries(
  PROVIDER_CHAIN.map((p) => [p.envKey, process.env[p.envKey]]),
);

for (const p of PROVIDER_CHAIN) {
  if (only && !only.includes(p.id)) continue;
  if (!keys[p.envKey]) {
    console.log(`${p.label.padEnd(13)} — no key`);
    continue;
  }
  for (const q of PROVIDER_CHAIN) delete process.env[q.envKey];
  process.env[p.envKey] = keys[p.envKey]!;

  for (const tier of ['standard', 'fast'] as const)
  for (const slice of sample) {
    const t = Date.now();
    try {
      const out = await extractFromSlice(slice, {
        tier,
        deadlineMs: 60_000,
        timeoutMs: 30_000,
      });
      const n =
        (out.skills?.length ?? 0) +
        (out.projects?.length ?? 0) +
        (out.experience?.length ?? 0) +
        (out.education?.length ?? 0) +
        (out.certifications?.length ?? 0) +
        (out.achievements?.length ?? 0);
      console.log(
        `${p.label.padEnd(13)} ${tier.padEnd(9)} ${String(Date.now() - t).padStart(6)}ms  ` +
          `${String(slice.content.length).padStart(5)}ch  ${n} facts  ${slice.path}`,
      );
    } catch (err) {
      console.log(
        `${p.label.padEnd(13)} ${tier.padEnd(9)} ${String(Date.now() - t).padStart(6)}ms  ` +
          `${String(slice.content.length).padStart(5)}ch  FAIL ${(err as Error).message.slice(0, 130)}`,
      );
    }
  }
}
for (const [k, v] of Object.entries(keys)) if (v) process.env[k] = v;
