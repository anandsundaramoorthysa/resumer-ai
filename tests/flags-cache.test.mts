/** lib/server/flags.ts — caching, dedupe, env override, fail-open. */

import { assert, suiteAsync, testAsync } from './harness.mjs';
import { __resetFlags, assertFlag, FlagOffError, flagOn, getFlag } from '../lib/server/flags';

await suiteAsync('flags', async () => {
  await testAsync('default when row absent; value when present; one query for concurrent reads', async () => {
    let calls = 0;
    __resetFlags(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return new Map([['radar_enabled', 'false']]);
    });
    const [a, b, c] = await Promise.all([flagOn('radar_enabled'), flagOn('ai_enabled'), getFlag('maintenance_message', 'x')]);
    assert(a === false && b === true && c === 'x', `${a} ${b} ${c}`);
    assert(calls === 1, `deduped (${calls})`);
    await flagOn('radar_enabled');
    assert(calls === 1, 'cached');
  });

  await testAsync('assertFlag throws a user-safe error when off', async () => {
    __resetFlags(async () => new Map([['ai_enabled', 'off']]));
    let err: unknown;
    try {
      await assertFlag('ai_enabled');
    } catch (e) {
      err = e;
    }
    assert(err instanceof FlagOffError && !/sql|postgres/i.test(err.message), 'FlagOffError');
  });

  await testAsync('DB error fails open to defaults', async () => {
    __resetFlags(async () => {
      throw new Error('connection refused');
    });
    assert((await flagOn('radar_enabled')) === true, 'open');
    assert((await getFlag('maintenance_message', 'd')) === 'd', 'default');
  });

  await testAsync('env override wins, without touching the DB', async () => {
    let calls = 0;
    __resetFlags(async () => {
      calls += 1;
      return new Map([['signups_enabled', 'true']]);
    });
    process.env.FLAG_SIGNUPS_ENABLED = 'false';
    const v = await flagOn('signups_enabled');
    delete process.env.FLAG_SIGNUPS_ENABLED;
    assert(v === false && calls === 0, 'env');
  });
});
