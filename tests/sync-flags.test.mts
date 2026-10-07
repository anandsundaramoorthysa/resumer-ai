/**
 * Flags, partial passes and hashes in lib/sync/reconcile.ts and lib/sync/partial.ts.
 *
 *   - a flagged record that the repository mentions again is un-flagged (it used to stay
 *     flagged — and so out of every resume — until the user clicked Keep)
 *   - a partial pass never flags anything and never lets the SHA be stored
 *   - the same sentence in two Unicode forms is one hash, and rows hashed before NFC are
 *     still recognised
 */

import { hashContent, hashVariants, legacyHashContent, bulletHash, reconcile, summarizePlan, identityKeyOf } from '../lib/sync/reconcile';
import { judgePass, mark, splitPartials } from '../lib/sync/partial';
import type { ParsedRecord } from '../lib/sync/reconcile';
import type { ProfileRecord } from '../lib/types';
import { suite, test, assert } from './harness.mjs';

const skillHash = (name: string) => hashContent(['skill', name, 'tool']);

function stored(name: string, over: Record<string, unknown> = {}): ProfileRecord {
  return {
    id: `id-${name}`,
    userId: 'u1',
    type: 'skill',
    name,
    category: 'tool',
    tags: [],
    contentHash: skillHash(name),
    source: 'github-sync',
    reviewState: 'approved',
    flaggedForRemoval: false,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...over,
  } as unknown as ProfileRecord;
}

const parsed = (name: string): ParsedRecord =>
  ({ type: 'skill', name, category: 'tool', tags: [], contentHash: skillHash(name) }) as unknown as ParsedRecord;

suite('a flagged record that is found again', () => {
  test('REPRO: unchanged + flagged now plans an un-flag (was unchanged:1, nothing else)', () => {
    const plan = reconcile([stored('Kubernetes', { flaggedForRemoval: true })], [parsed('Kubernetes')]);
    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.toUnflag, [{ id: 'id-Kubernetes' }]);
    assert.equal(plan.toFlag.length, 0);
    assert.match(summarizePlan(plan), /flag cleared/);
  });

  test('an unflagged record plans no un-flag', () => {
    assert.equal(reconcile([stored('Kubernetes')], [parsed('Kubernetes')]).toUnflag.length, 0);
  });

  test('re-worded (identity match) and flagged is also un-flagged, once', () => {
    const row = stored('Kubernetes', { flaggedForRemoval: true, contentHash: 'legacy-hash' });
    const plan = reconcile([row], [parsed('Kubernetes'), parsed('Kubernetes')]);
    assert.equal(plan.toUnflag.length, 1);
    assert.ok(plan.toUpdate.length >= 1);
  });

  test('a flagged record that is still missing stays flagged and is not re-flagged', () => {
    const plan = reconcile([stored('Kubernetes', { flaggedForRemoval: true })], [parsed('Docker')]);
    assert.equal(plan.toUnflag.length, 0);
    assert.equal(plan.toFlag.length, 0);
  });

  test('user intent wins: a record the user removed is refused, never un-flagged or restored', () => {
    const row = stored('Kubernetes', { flaggedForRemoval: true });
    const plan = reconcile([row], [parsed('Kubernetes')], [
      { contentHash: skillHash('Kubernetes'), identityKey: identityKeyOf(row) },
    ]);
    assert.equal(plan.toUnflag.length, 0);
    assert.equal(plan.refused, 1);
  });

  test('manual records are never read, so never un-flagged', () => {
    const plan = reconcile([stored('Kubernetes', { source: 'manual', flaggedForRemoval: true })], [parsed('Kubernetes')]);
    assert.equal(plan.toUnflag.length, 0);
  });
});

suite('flagMissing: false (a partial pass)', () => {
  const rows = [stored('Kubernetes'), stored('Docker')];
  test('a complete pass flags what is missing', () => {
    assert.equal(reconcile(rows, [parsed('Docker')]).toFlag.length, 1);
  });
  test('a partial pass flags nothing', () => {
    assert.equal(reconcile(rows, [parsed('Docker')], [], { flagMissing: false }).toFlag.length, 0);
  });
  test('a partial pass still un-flags what it did see', () => {
    const plan = reconcile([stored('Docker', { flaggedForRemoval: true })], [parsed('Docker')], [], { flagMissing: false });
    assert.equal(plan.toUnflag.length, 1);
  });
});

suite('partial-pass bookkeeping', () => {
  const extraction = { skills: [] };

  test('a clean pass: complete, SHA stored, flags allowed, no notice', () => {
    const v = judgePass(splitPartials([extraction, extraction]));
    assert.deepEqual([v.complete, v.storeSha, v.flagMissing, v.notice], [true, true, true, null]);
  });

  test('REPRO: a slice that failed 3 times means no flagging, no SHA, and a "Partial sync" notice', () => {
    const s = splitPartials([extraction, mark('skipped', 'content/a.json'), mark('skipped', 'content/b.json')]);
    assert.equal(s.extractions.length, 1, 'marks are stripped before merging');
    const v = judgePass(s);
    assert.equal(v.flagMissing, false);
    assert.equal(v.storeSha, false);
    assert.equal(v.notice, 'Partial sync — 2 parts skipped, nothing was removed; try again');
  });

  test('a failed blob or truncated tree counts the same, and a rate limit is named', () => {
    const v = judgePass(splitPartials([mark('incomplete', 'GitHub rate limit — try again at 10:05 UTC')]));
    assert.equal(v.storeSha, false);
    assert.equal(v.flagMissing, false);
    assert.match(v.notice ?? '', /^Partial sync — 1 part skipped, nothing was removed; try again/);
    assert.match(v.notice ?? '', /10:05 UTC/);
  });

  test('files left out on purpose suppress flagging but still let the SHA be stored', () => {
    const v = judgePass(splitPartials([mark('unread', '3 content files were over the limit.')]));
    assert.equal(v.flagMissing, false);
    assert.equal(v.storeSha, true);
  });
});

suite('NFC in content hashes', () => {
  const composed = 'Built a Café ordering app';
  const decomposed = 'Built a Café ordering app';

  test('composed and decomposed text hash identically', () => {
    assert.notEqual(composed, decomposed);
    assert.equal(hashContent(['bullet', 'Acme', composed]), hashContent(['bullet', 'Acme', decomposed]));
    assert.equal(bulletHash('Acme', composed), bulletHash('Acme', decomposed));
  });

  test('case and whitespace folding still apply', () => {
    assert.equal(hashContent([' CAFÉ  au lait ']), hashContent(['café au lait']));
  });

  test('ZWJ and ZWNJ survive: they are letters in some scripts, not whitespace', () => {
    assert.notEqual(hashContent(['क्‍ष']), hashContent(['क्ष']));
    assert.notEqual(hashContent(['a‌b']), hashContent(['ab']));
    assert.notEqual(hashContent(['👩‍💻']), hashContent(['👩💻']));
  });

  test('ASCII hashes are unchanged, so existing rows still match', () => {
    assert.equal(hashContent(['skill', 'TypeScript', 'tool']), legacyHashContent(['skill', 'TypeScript', 'tool']));
  });

  test('a row hashed before NFC (decomposed text) is among the variants of the same text', () => {
    const legacyStored = legacyHashContent(['bullet', 'Acme', decomposed]);
    assert.notEqual(legacyStored, hashContent(['bullet', 'Acme', decomposed]));
    assert.ok(hashVariants(['bullet', 'Acme', composed]).includes(legacyStored));
    assert.ok(hashVariants(['bullet', 'Acme', decomposed]).includes(legacyStored));
  });

  test('reconcile matches a legacy-hashed row by identity and re-keys it, never proposes it again', () => {
    const row = stored('Café Design', { contentHash: legacyHashContent(['skill', 'Café Design', 'tool']) });
    const plan = reconcile([row], [parsed('Café Design')]);
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.toUpdate.length, 1);
    assert.equal(plan.toFlag.length, 0);
  });
});
