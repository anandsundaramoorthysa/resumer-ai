/** lib/server/housekeeping.ts — the pure parts: cutoffs and the batch loop. (SQL is exercised on PGlite by hand.) */

import { assert, suiteAsync, testAsync } from './harness.mjs';
import { batched, cutoffs, RETENTION } from '../lib/server/housekeeping';

await suiteAsync('housekeeping', async () => {
  await testAsync('cutoffs are exact functions of now', async () => {
    const now = new Date('2026-10-07T03:30:00.000Z');
    const c = cutoffs(now);
    assert(c.draftRun === '2026-07-09T03:30:00.000Z', c.draftRun); // 90 days
    assert(c.deniedAccount === '2026-09-07T03:30:00.000Z', c.deniedAccount);
    assert(c.auditLog === '2025-10-07T03:30:00.000Z', c.auditLog); // 12 months
    assert(c.inactiveAccount === '2024-10-07T03:30:00.000Z', c.inactiveAccount); // 24 months
    assert(RETENTION.auditPromptDays === 90 && c.syncJob === '2026-09-30T03:30:00.000Z', 'prompt 90d, sync jobs 7d');
  });

  await testAsync('batched loops until a short batch', async () => {
    const left = [500, 500, 120];
    const r = await batched(async () => left.shift() ?? 0, { deadline: Date.now() + 5000 });
    assert(r.n === 1120 && !r.more, JSON.stringify(r));
  });

  await testAsync('batched stops at the deadline and says more is left', async () => {
    let t = 0;
    const r = await batched(async () => 500, { deadline: 3, now: () => t++ });
    assert(r.more && r.n === 1500, JSON.stringify(r));
  });

  await testAsync('batched stops at the batch cap', async () => {
    const r = await batched(async () => 10, { deadline: Date.now() + 5000, batch: 10, maxBatches: 3 });
    assert(r.n === 30 && r.more, JSON.stringify(r));
  });

  await testAsync('an empty table is one query and no more', async () => {
    let calls = 0;
    const r = await batched(async () => (calls++, 0), { deadline: Date.now() + 5000 });
    assert(calls === 1 && r.n === 0 && !r.more, 'one call');
  });
});
