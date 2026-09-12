/**
 * What a removal blocks, and what it must not — lib/profile/dismissals.ts and the sync
 * planner that consults it.
 *
 * The bug this exists for: removing an entry deleted the row and nothing else, so the next
 * sync read the same portfolio, saw a fact the profile did not have, and proposed it again.
 * The user answered the same question every sync, forever. A denial in the review queue
 * never had this problem — it leaves a rejected row behind — so the two paths disagreed
 * about what "no" meant depending on where you said it.
 */

import { suite, test, assert } from './harness.mjs';
import { dismissalFilter } from '../lib/profile/dismissals';
import { reconcile, hashContent, type ParsedRecord } from '../lib/sync/reconcile';
import type { ProfileRecord } from '../lib/types';

const skill = (name: string): ParsedRecord =>
  ({
    type: 'skill',
    name,
    category: 'tool',
    tags: [name.toLowerCase()],
    contentHash: hashContent(['skill', name, 'tool']),
  }) as unknown as ParsedRecord;

const award = (title: string): ParsedRecord =>
  ({
    type: 'award',
    title,
    tags: [],
    contentHash: hashContent(['honor', title.toLowerCase()]),
  }) as unknown as ParsedRecord;

suite('what a removal blocks', () => {
  test('the same fact, by fingerprint', () => {
    const blocked = dismissalFilter([{ contentHash: 'h1', identityKey: 'skill:docker' }]);
    assert.equal(blocked({ contentHash: 'h1' }), true);
    assert.equal(blocked({ contentHash: 'h2' }), false);
  });

  test('the same fact written differently, by identity', () => {
    // The point of keeping both keys: a portfolio edited between syncs proposes the same
    // skill with a new hash, and a block that only knew the old hash would let it back.
    const blocked = dismissalFilter([{ contentHash: 'old', identityKey: 'skill:docker' }]);
    assert.equal(blocked({ contentHash: 'new', identityKey: 'skill:docker' }), true);
  });

  test('a mark with no identity blocks only its own text', () => {
    // A summary is stored this way on purpose: its identity is the single slot, so an
    // identity block would refuse every future summary rather than the removed sentence.
    const blocked = dismissalFilter([{ contentHash: 'h1', identityKey: null }]);
    assert.equal(blocked({ contentHash: 'h2', identityKey: 'summary' }), false);
  });

  test('an empty identity is not an identity', () => {
    const blocked = dismissalFilter([{ contentHash: 'h1', identityKey: '' }]);
    assert.equal(blocked({ contentHash: 'h2', identityKey: '' }), false);
  });

  test('nothing removed blocks nothing', () => {
    const blocked = dismissalFilter([]);
    assert.equal(blocked({ contentHash: 'anything', identityKey: 'skill:x' }), false);
  });
});

suite('a sync does not propose what was removed', () => {
  test('a removed skill is refused, not re-proposed', () => {
    const parsed = [skill('Docker'), skill('Airflow')];
    const plan = reconcile([], parsed, [
      { contentHash: parsed[0].contentHash, identityKey: 'skill:docker' },
    ]);
    assert.equal(plan.toInsert.length, 1);
    assert.equal((plan.toInsert[0] as unknown as { name: string }).name, 'Airflow');
    assert.equal(plan.refused, 1);
  });

  test('reworded in the portfolio, still refused', () => {
    // Same award, re-titled at the source: a new fingerprint, the same identity.
    const parsed = [award('Best Innovation Award')];
    const plan = reconcile([], parsed, [
      { contentHash: 'a-different-hash', identityKey: 'honor:best innovation' },
    ]);
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.refused, 1);
  });

  test('with no marks, the sync behaves exactly as before', () => {
    const parsed = [skill('Docker')];
    assert.equal(reconcile([], parsed).toInsert.length, 1);
    assert.equal(reconcile([], parsed, []).toInsert.length, 1);
  });

  test('a removal does not block the rest of its type', () => {
    const parsed = [skill('Docker'), skill('Kubernetes'), award('Best Innovation Award')];
    const plan = reconcile([], parsed, [
      { contentHash: parsed[0].contentHash, identityKey: 'skill:docker' },
    ]);
    assert.equal(plan.toInsert.length, 2);
  });

  test('a stored row still wins over a mark, so nothing on the profile is disturbed', () => {
    // A record the user kept, whose fact was also removed once and typed back in: the
    // mark is lifted on write, but even if one lingered, reconcile must treat the stored
    // row as known rather than planning anything against it.
    const stored = {
      ...(skill('Docker') as unknown as ProfileRecord),
      id: 'r1',
      userId: 'u1',
      source: 'github-sync',
      reviewState: 'approved',
      flaggedForRemoval: false,
    } as ProfileRecord;
    const plan = reconcile([stored], [skill('Docker')], []);
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.unchanged, 1);
  });
});
