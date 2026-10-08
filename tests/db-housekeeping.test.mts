/**
 * lib/server/housekeeping.ts against a real Postgres engine: the daily retention sweep.
 * The case worth a real engine is `ai_usage_daily`, whose composite primary key means it
 * cannot use the shared `delete ... where id in (...)` helper.
 */
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { mkUser, all } from './db/seed.mjs';
import { cutoffs, runHousekeeping } from '../lib/server/housekeeping';

const t = await installTestDb();
const { pg } = t;
const u = await mkUser(pg);

const daysOf = async (): Promise<string[]> =>
  (await all<{ day: string }>(pg, 'select day from ai_usage_daily where user_id=$1 order by day', [u])).map((r) => r.day);

const minusDay = (day: string): string =>
  new Date(new Date(`${day}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

await suiteAsync('housekeeping: retention sweep', async () => {
  await testAsync('ai_usage_daily older than the cutoff is purged; the cutoff day itself stays', async () => {
    const now = new Date('2026-10-07T03:30:00.000Z');
    const cutoff = cutoffs(now).aiUsageDaily;
    const stale = minusDay(cutoff);
    await pg.query(
      'insert into ai_usage_daily (user_id, day, calls, tokens) values ($1, $2, 1, 10), ($1, $3, 2, 20), ($1, $4, 3, 30)',
      [u, stale, cutoff, '2026-10-07'],
    );
    assert.deepEqual(await daysOf(), [stale, cutoff, '2026-10-07']);

    const out = await runHousekeeping(now, { scope: 'daily' });
    assert.equal(out.aiUsageDailyDeleted, 1, JSON.stringify(out.errors));
    assert.ok(!out.errors.some((e) => e.startsWith('ai usage daily')), JSON.stringify(out.errors));
    assert.deepEqual(await daysOf(), [cutoff, '2026-10-07']);
  });

  await testAsync('a second sweep finds nothing and deletes nothing', async () => {
    const now = new Date('2026-10-07T03:30:00.000Z');
    const out = await runHousekeeping(now, { scope: 'daily' });
    assert.equal(out.aiUsageDailyDeleted, 0, JSON.stringify(out.errors));
    assert.equal(await daysOf().then((d) => d.length), 2);
  });

  await testAsync('the hourly scope leaves usage counts alone', async () => {
    const now = new Date('2027-10-07T03:30:00.000Z');
    const out = await runHousekeeping(now, { scope: 'hourly' });
    assert.equal(out.aiUsageDailyDeleted, 0, JSON.stringify(out.errors));
    assert.equal(await daysOf().then((d) => d.length), 2);
  });
});
