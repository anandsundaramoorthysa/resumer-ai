/**
 * The Job Radar's SQL — run store and serp cache — against a real Postgres engine (PGlite),
 * in every `npm test`. The scenarios are scripts/verify-radar-db.mts, which also run against
 * a live database by hand; here they run against a throwaway one built from the schema.
 */
import { suite, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { scenarios } from '../scripts/verify-radar-db.mjs';

const t = await installTestDb();
await suite('radar run store + serp cache on Postgres', () => {});
await testAsync('every real-SQL radar scenario passes', async () => {
  const res = await scenarios(t.db as never);
  assert.ok(res.passed > 20, `only ${res.passed} scenarios ran`);
  assert.deepEqual(res.failed, []);
});
await t.close();
