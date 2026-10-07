/**
 * The sync's SQL guards (step claim, compare-and-set, flag / un-flag) against a real
 * Postgres engine (PGlite) — scripts/verify-sync-db.mts scenarios, in every `npm test`.
 */
import { suite, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { scenarios } from '../scripts/verify-sync-db.mjs';

const t = await installTestDb();
await suite('sync guards on Postgres', () => {});
await testAsync('every real-SQL sync scenario passes', async () => {
  const res = await scenarios(t.db as never);
  assert.ok(res.passed > 5, `only ${res.passed} scenarios ran`);
  assert.deepEqual(res.failed, []);
});
await t.close();
