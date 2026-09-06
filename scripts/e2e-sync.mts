/**
 * End-to-end portfolio sync against the real repository and the real database.
 *
 * Drives the stepped job exactly the way the browser does — one call per step — and
 * times each one. The pass/fail question is not just "did it finish" but "did every
 * single step fit inside a serverless function's window", because that is the whole
 * reason the job is stepped at all.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-sync.mts [--force] [--reset]
 *
 *   --force   ignore the SHA gate, so an unchanged repo still runs a full sync
 *   --reset   delete this user's github-sync records first, exercising the insert path
 *             on an empty profile rather than the reconcile path
 */
import 'dotenv/config';
import postgres from 'postgres';
import { startSyncJob, advanceSyncJob } from '../lib/sync/stepped';

/** Netlify's non-streaming function limit — the tightest host this has to run on. */
const STEP_LIMIT_MS = 10_000;

const force = process.argv.includes('--force');
const reset = process.argv.includes('--reset');

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const [u] = await sql<{ id: string }[]>`select id from "user" limit 1`;
if (!u) throw new Error('No user row — sign in through the app once first.');

// A job left running by an interrupted run would be adopted instead of a fresh one.
await sql`update sync_job set status = 'error', error = 'superseded by e2e run'
          where status = 'running' and user_id = ${u.id}`;

if (reset) {
  await sql`delete from profile_record where user_id = ${u.id} and source = 'github-sync'`;
  await sql`delete from role where user_id = ${u.id} and source = 'github-sync'`;
  await sql`delete from contact_info where user_id = ${u.id}`;
  console.log('reset: cleared github-sync records, roles and contact');
}
if (force || reset) {
  await sql`update "user" set last_synced_sha = null where id = ${u.id}`;
  console.log('force: cleared last_synced_sha');
}
await sql.end();

const t0 = Date.now();
const timings: Array<{ step: number; ms: number; message: string }> = [];

let state = await startSyncJob(u.id);
console.log(`step ${state.step}/${state.totalSteps}: ${state.message}`);

for (let i = 0; i < 80 && !state.done; i++) {
  const t = Date.now();
  state = await advanceSyncJob(u.id, state.jobId);
  const ms = Date.now() - t;
  timings.push({ step: state.step, ms, message: state.message });
  console.log(
    `step ${String(state.step).padStart(2)}/${state.totalSteps}` +
      ` (${String(ms + 'ms').padStart(7)})${ms >= STEP_LIMIT_MS ? ' OVER' : '     '}` +
      ` ${state.message}`,
  );
}

console.log(`\nfinal: ${state.status} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (state.error) console.log('error:', state.error);

const over = timings.filter((t) => t.ms >= STEP_LIMIT_MS);
const slowest = timings.reduce((a, b) => (b.ms > a.ms ? b : a), timings[0]);
console.log(
  `steps: ${timings.length}` +
    `  slowest ${slowest?.ms}ms (step ${slowest?.step})` +
    `  over ${STEP_LIMIT_MS}ms: ${over.length}`,
);
if (over.length) {
  for (const t of over) console.log(`  OVER  step ${t.step}: ${t.ms}ms — ${t.message}`);
  process.exitCode = 1;
}
