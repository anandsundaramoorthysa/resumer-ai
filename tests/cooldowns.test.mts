/**
 * The provider cooldown store — lib/ai/cooldowns.ts.
 *
 * The cooldown used to be a module-level Map, which on a serverless host is worth
 * nothing: every cold invocation started empty and re-paid the same lesson. Measured in
 * production, an overloaded Gemini cost every draft 4-13 seconds of a 20-second budget.
 * Making it shared introduced two new ways to be wrong, and both are pinned here:
 *
 *  - the read/write/expiry decisions, which are pure and must not drift;
 *  - and that a missing or broken database DEGRADES to the old in-memory behaviour
 *    rather than throwing. A draft failing because a cooldown row could not be read
 *    would be a far worse bug than the one this replaced.
 */

// A DATABASE_URL leaking in from the shell would silently turn the no-database suite
// below into a live one. Removing it here is enough despite ESM hoisting the imports
// above this line: the store resolves its backend lazily, on the first read or bench.
delete process.env.DATABASE_URL;

import {
  cooldownMsFor,
  cooldownSnapshot,
  isCoolingDown,
  loadCooldowns,
  mergeCooldowns,
  noteBench,
  resetCooldownCache,
  setCooldownBackend,
  shouldRead,
  QUOTA_COOLDOWN_MS,
  SLOW_COOLDOWN_MS,
  READ_CACHE_MS,
  type Cooldown,
  type CooldownEntry,
} from '../lib/ai/cooldowns';
import type { ProviderId } from '../lib/ai/models';
import { suite, suiteAsync, test, testAsync, assert } from './harness.mjs';

const NOW = 1_700_000_000_000;

function local(entries: Array<[ProviderId, Cooldown]>): Map<ProviderId, Cooldown> {
  return new Map(entries);
}

suite('cooldown — how long, and when to re-read', () => {
  test('quota is benched for longer than overload or slow', () => {
    // The existing semantics, unchanged by making the store shared: a provider out of
    // quota will still be out in a minute, an overloaded one is "usually temporary".
    assert.equal(cooldownMsFor('quota'), QUOTA_COOLDOWN_MS);
    assert.equal(cooldownMsFor('overload'), SLOW_COOLDOWN_MS);
    assert.equal(cooldownMsFor('slow'), SLOW_COOLDOWN_MS);
    assert.ok(QUOTA_COOLDOWN_MS > SLOW_COOLDOWN_MS);
  });

  test('a process that has never read is always due', () => {
    // Not a comparison against a stored expiry: with lastReadAt at 0 and a small clock,
    // an expiry check would decide the cache was fresh and never read at all.
    assert.equal(shouldRead(0, 0), true);
    assert.equal(shouldRead(0, NOW), true);
  });

  test('a read inside the window is reused, and one outside it is not', () => {
    assert.equal(shouldRead(NOW, NOW + READ_CACHE_MS - 1), false);
    assert.equal(shouldRead(NOW, NOW + READ_CACHE_MS), true);
    assert.equal(shouldRead(NOW, NOW + READ_CACHE_MS * 10), true);
  });
});

suite('cooldown — merging what the database knows into what we know', () => {
  test('an expired row benches nobody', () => {
    // Nothing prunes the table, so most rows are expired once an outage passes. A stale
    // row that still benched would keep a healthy provider out of the chain for good.
    const merged = mergeCooldowns(local([]), [row('google', NOW - 1)], NOW);
    assert.equal(merged.size, 0);
  });

  test('an expired local entry is dropped too', () => {
    const merged = mergeCooldowns(local([['groq', { until: NOW - 1, reason: 'slow' }]]), [], NOW);
    assert.equal(merged.size, 0);
  });

  test('a bench this process has not seen is adopted', () => {
    const merged = mergeCooldowns(local([]), [row('google', NOW + 60_000, 'overload')], NOW);
    assert.equal(merged.get('google')?.until, NOW + 60_000);
    assert.equal(merged.get('google')?.reason, 'overload');
  });

  test('the later instant wins, whichever side it came from', () => {
    // The local entry is usually the newer one — we may have benched the provider
    // ourselves seconds after the read that is being merged. Taking the earlier instant
    // would un-bench a provider we just watched fail.
    const ours = local([['google', { until: NOW + 90_000, reason: 'quota' }]]);
    assert.equal(mergeCooldowns(ours, [row('google', NOW + 10_000)], NOW).get('google')?.until, NOW + 90_000);
    assert.equal(mergeCooldowns(ours, [row('google', NOW + 120_000)], NOW).get('google')?.until, NOW + 120_000);
  });

  test('providers are kept apart', () => {
    const merged = mergeCooldowns(
      local([['google', { until: NOW + 1000, reason: 'quota' }]]),
      [row('fireworks', NOW + 2000)],
      NOW,
    );
    assert.deepEqual([...merged.keys()].sort(), ['fireworks', 'google']);
  });
});

await suiteAsync('cooldown — with no database at all', async () => {
  // DATABASE_URL was deleted at the top of this file, so this is the real default
  // backend resolving to "nothing to persist to" — not a fake standing in for it.
  await testAsync('a read resolves quietly instead of throwing', async () => {
    await loadCooldowns();
    assert.deepEqual(cooldownSnapshot(), []);
  });

  await testAsync('a bench still works, in memory, exactly as it used to', async () => {
    resetCooldownCache();
    const until = noteBench('google', 'quota');

    assert.equal(isCoolingDown('google'), true);
    assert.equal(isCoolingDown('groq'), false, 'benching one provider must not bench the rest');
    assert.equal(isCoolingDown('google', until + 1), false, 'and it must expire');

    // The write is fired and not awaited; nothing about it may reject when there is
    // nowhere to write to.
    await settle();
  });
});

await suiteAsync('cooldown — reading and writing through a store', async () => {
  await testAsync('one read per call, reused inside the cache window', async () => {
    let reads = 0;
    setCooldownBackend({
      async read() {
        reads += 1;
        return [row('google', Date.now() + 60_000, 'overload')];
      },
      async write() {},
    });

    await loadCooldowns();
    assert.equal(reads, 1);
    assert.equal(isCoolingDown('google'), true, 'a bench from another process must be adopted');

    // A draft makes several chain calls. They must not become several queries.
    await loadCooldowns();
    await loadCooldowns();
    assert.equal(reads, 1, 'a second call inside the cache window must not query again');
  });

  await testAsync('concurrent calls in one instance share a single query', async () => {
    let reads = 0;
    setCooldownBackend({
      async read() {
        reads += 1;
        await new Promise((r) => setTimeout(r, 10));
        return [];
      },
      async write() {},
    });

    await Promise.all([loadCooldowns(), loadCooldowns(), loadCooldowns()]);
    assert.equal(reads, 1);
  });

  await testAsync('a bench is written once, with the right reason and instant', async () => {
    const written: CooldownEntry[] = [];
    setCooldownBackend({
      async read() {
        return [];
      },
      async write(entry) {
        written.push(entry);
      },
    });

    const before = Date.now();
    noteBench('togetherai', 'slow');
    await settle();

    assert.equal(written.length, 1, 'exactly one write per bench — never one per attempt');
    assert.equal(written[0].providerId, 'togetherai');
    assert.equal(written[0].reason, 'slow');
    assert.ok(
      written[0].until >= before + SLOW_COOLDOWN_MS && written[0].until <= Date.now() + SLOW_COOLDOWN_MS,
      'the persisted instant must match the one this process is using',
    );
  });

  await testAsync('reading writes nothing', async () => {
    let writes = 0;
    setCooldownBackend({
      async read() {
        return [row('groq', Date.now() + 30_000)];
      },
      async write() {
        writes += 1;
      },
    });

    await loadCooldowns();
    await settle();
    assert.equal(writes, 0);
  });
});

await suiteAsync('cooldown — a database that is there but broken', async () => {
  await testAsync('a failing read degrades to memory instead of throwing', async () => {
    setCooldownBackend({
      async read() {
        throw new Error('connection terminated unexpectedly');
      },
      async write() {},
    });

    noteBench('deepinfra', 'quota');
    await loadCooldowns(); // must not reject
    assert.equal(
      isCoolingDown('deepinfra'),
      true,
      'a failed read must not discard what this process already knows',
    );
  });

  await testAsync('a failing write does not reject into the caller', async () => {
    setCooldownBackend({
      async read() {
        return [];
      },
      async write() {
        throw new Error('relation "ai_provider_cooldown" does not exist');
      },
    });

    resetCooldownCache();
    noteBench('fireworks', 'overload');
    await settle();
    assert.equal(isCoolingDown('fireworks'), true, 'the local bench stands either way');
  });
});

// Leave the module as the next importer would find it.
setCooldownBackend(null);

function row(providerId: ProviderId, until: number, reason: CooldownEntry['reason'] = 'quota'): CooldownEntry {
  return { providerId, until, reason };
}

/**
 * A macrotask, which flushes every pending microtask behind it — the write is fired and
 * not awaited, so there is no promise for a test to hold.
 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}
