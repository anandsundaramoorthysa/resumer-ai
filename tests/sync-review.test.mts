/**
 * The rule that decides what a sync may write and what it must ask about.
 *
 * This is the pinned version of a policy that used to be "add everything", which meant
 * an LLM reading a git repository could write straight into the profile that every
 * later check measures against. The rule now is: a new claim is proposed, a change to
 * an approved claim is applied, a disappearance is flagged, a rejection is remembered.
 *
 * Both halves matter and pull against each other, so both are tested. Too little review
 * and a repository writes someone's career history; too much and every sync re-asks
 * about an unchanged profile, which is how the feature gets switched off — and a sync
 * nobody runs protects nobody.
 */

import { createHash } from 'node:crypto';
import { hashContent, reconcile, summarizePlan } from '../lib/sync/reconcile';
import type { ParsedRecord } from '../lib/sync/reconcile';
import { canConnectWithPermissions } from '../lib/server/repo-access';
import type { ProfileRecord, RecordSource, ReviewState } from '../lib/types';
import { suite, test, assert } from './harness.mjs';

interface StoredOpts {
  source?: RecordSource;
  reviewState?: ReviewState;
  flagged?: boolean;
}

const skillHash = (name: string) => hashContent(['skill', name, 'tool']);
const projectHash = (name: string, description: string) =>
  hashContent(['project', name, description, '']);

function storedSkill(name: string, opts: StoredOpts = {}): ProfileRecord {
  return {
    id: `id-${name}`,
    userId: 'u1',
    type: 'skill',
    name,
    category: 'tool',
    tags: [],
    contentHash: skillHash(name),
    source: opts.source ?? 'github-sync',
    reviewState: opts.reviewState ?? 'approved',
    flaggedForRemoval: opts.flagged ?? false,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  } as unknown as ProfileRecord;
}

function parsedSkill(name: string, tags: string[] = []): ParsedRecord {
  return {
    type: 'skill',
    name,
    category: 'tool',
    tags,
    contentHash: skillHash(name),
  } as unknown as ParsedRecord;
}

function storedProject(
  name: string,
  description: string,
  opts: StoredOpts = {},
): ProfileRecord {
  return {
    id: `id-${name}`,
    userId: 'u1',
    type: 'project',
    name,
    description,
    stack: [],
    links: [],
    impactMetrics: [],
    tags: [],
    contentHash: projectHash(name, description),
    source: opts.source ?? 'github-sync',
    reviewState: opts.reviewState ?? 'approved',
    flaggedForRemoval: opts.flagged ?? false,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  } as unknown as ProfileRecord;
}

function parsedProject(name: string, description: string): ParsedRecord {
  return {
    type: 'project',
    name,
    description,
    stack: [],
    links: [],
    impactMetrics: [],
    tags: [],
    contentHash: projectHash(name, description),
  } as unknown as ParsedRecord;
}

/* ------------------------------------------------- new claims are proposed ---- */

suite('a claim the profile has never seen', () => {
  test('is proposed, never written', () => {
    const plan = reconcile([], [parsedSkill('Kubernetes')]);
    assert.equal(plan.toInsert.length, 1);
    assert.equal(plan.toUpdate.length, 0);
    assert.equal(plan.unchanged, 0);
  });

  test('is proposed even when the profile already holds other approved facts', () => {
    // The realistic shape of an attack: one invented line appended to a real portfolio.
    const plan = reconcile(
      [storedSkill('TypeScript'), storedSkill('Postgres')],
      [parsedSkill('TypeScript'), parsedSkill('Postgres'), parsedSkill('Kubernetes')],
    );
    assert.equal(plan.toInsert.length, 1);
    assert.equal((plan.toInsert[0] as unknown as { name: string }).name, 'Kubernetes');
    assert.equal(plan.unchanged, 2);
  });
});

/* ------------------------------------------- approvals are not re-litigated ---- */

suite('what does not need review', () => {
  test('an approved record still in the repo is not asked about again', () => {
    const plan = reconcile([storedSkill('TypeScript')], [parsedSkill('TypeScript')]);
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.toUpdate.length, 0);
    assert.equal(plan.toFlag.length, 0);
    assert.equal(plan.unchanged, 1);
  });

  test('a re-wording of an approved record is applied without asking', () => {
    const plan = reconcile(
      [storedProject('Resumer', 'A resume builder.')],
      [parsedProject('Resumer', 'A resume builder that checks its own output.')],
    );
    assert.equal(plan.toUpdate.length, 1, 'the change is applied');
    assert.equal(plan.toInsert.length, 0, 'and is not re-proposed as a new claim');
    assert.equal(plan.toUpdate[0].id, 'id-Resumer');
  });

  test('a tag refresh is an update, not a question', () => {
    const plan = reconcile([storedSkill('TypeScript')], [parsedSkill('TypeScript', ['lang'])]);
    assert.equal(plan.unchanged, 1);
    assert.equal(plan.toUpdate.length, 1);
    assert.equal(plan.toInsert.length, 0);
  });

  test('a disappearance is flagged, which is the review that already existed', () => {
    const plan = reconcile([storedSkill('TypeScript')], []);
    assert.equal(plan.toFlag.length, 1);
    assert.equal(plan.toInsert.length, 0);
  });
});

/* ------------------------------------------------ proposals already queued ---- */

suite('a proposal waiting in the queue', () => {
  test('is not proposed a second time by the next sync', () => {
    const plan = reconcile(
      [storedSkill('Kubernetes', { reviewState: 'pending' })],
      [parsedSkill('Kubernetes')],
    );
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.unchanged, 1);
  });

  test('is refreshed in place when the repo re-words it', () => {
    const plan = reconcile(
      [storedProject('Resumer', 'Old text.', { reviewState: 'pending' })],
      [parsedProject('Resumer', 'New text.')],
    );
    assert.equal(plan.toUpdate.length, 1, 'the queue shows the current wording');
    assert.equal(plan.toInsert.length, 0);
  });

  test('is not flagged when it vanishes from the repo', () => {
    // It was never in the profile, so there is nothing to warn about losing. Flagging it
    // would put one item in two review lists at once, asking both "is this yours?" and
    // "shall we drop this?" about the same never-accepted claim.
    const plan = reconcile([storedSkill('Kubernetes', { reviewState: 'pending' })], []);
    assert.equal(plan.toFlag.length, 0);
  });
});

/* ------------------------------------------------ rejections are permanent ---- */

suite('a claim the user rejected', () => {
  test('is not proposed again while it sits in the repo', () => {
    const plan = reconcile(
      [storedSkill('Kubernetes', { reviewState: 'rejected' })],
      [parsedSkill('Kubernetes')],
    );
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.toUpdate.length, 0);
    assert.equal(plan.refused, 1);
  });

  test('is still refused when the repo re-words it', () => {
    // Matching on the identity key as well as the hash is what makes rejection stick.
    // Hash alone and one edited character would put the claim back in the queue.
    const plan = reconcile(
      [storedProject('Resumer', 'Old text.', { reviewState: 'rejected' })],
      [parsedProject('Resumer', 'Completely different text.')],
    );
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.toUpdate.length, 0);
    assert.equal(plan.refused, 1);
  });

  test('is not flagged when it disappears — that decision is already made', () => {
    const plan = reconcile([storedSkill('Kubernetes', { reviewState: 'rejected' })], []);
    assert.equal(plan.toFlag.length, 0);
  });
});

/* ----------------------------------------------- manual records stay manual ---- */

suite('manual records', () => {
  test('are never flagged, updated or re-stated by a sync', () => {
    const manual = storedSkill('TypeScript', { source: 'manual' });
    const gone = reconcile([manual], []);
    assert.equal(gone.toFlag.length, 0);
    assert.equal(gone.toUpdate.length, 0);

    const present = reconcile([manual], [parsedSkill('TypeScript')]);
    assert.equal(present.toUpdate.length, 0, 'sync may not rewrite what the user typed');
  });
});

/* ----------------------------------------------------------- the summary ---- */

suite('the sentence the user is shown after a sync', () => {
  test('does not claim anything was added', () => {
    const plan = reconcile([], [parsedSkill('a'), parsedSkill('b'), parsedSkill('c')]);
    assert.equal(summarizePlan(plan), '3 new to review');
  });

  test('says nothing happened when nothing did', () => {
    assert.equal(
      summarizePlan(reconcile([storedSkill('TypeScript')], [parsedSkill('TypeScript')])),
      'Already up to date',
    );
  });

  test('mentions claims skipped because they were rejected before', () => {
    const plan = reconcile(
      [storedSkill('Kubernetes', { reviewState: 'rejected' })],
      [parsedSkill('Kubernetes')],
    );
    assert.equal(summarizePlan(plan), '1 previously rejected, skipped');
  });
});

/* -------------------------------------------------- who may connect a repo ---- */

suite('which repositories may be connected', () => {
  test('write access qualifies, however GitHub spells it', () => {
    assert(canConnectWithPermissions({ admin: true, push: true, pull: true }));
    assert(canConnectWithPermissions({ push: true, pull: true }));
    // An organisation portfolio maintained by a member with the maintain role: the
    // legitimate case that must keep working.
    assert(canConnectWithPermissions({ maintain: true, pull: true }));
  });

  test('read access does not', () => {
    // The whole finding in one assertion. An OAuth token can read every public
    // repository on GitHub, so accepting read access accepted a stranger's repo — whose
    // files an LLM then parsed into this user's profile.
    assert(!canConnectWithPermissions({ pull: true }));
    assert(!canConnectWithPermissions({ admin: false, push: false, pull: true }));
    assert(!canConnectWithPermissions({}));
    assert(!canConnectWithPermissions(undefined));
  });
});

suite('a content hash cannot have its boundaries moved', () => {
  test('two parts split differently are different facts', () => {
    assert.notEqual(hashContent(['ab', 'c']), hashContent(['a', 'bc']));
  });

  test('a missing part is not the same as no part at all', () => {
    assert.notEqual(hashContent(['skill', '', 'python']), hashContent(['skill', 'python']));
  });

  test('the same parts still hash the same, however often it is asked', () => {
    assert.equal(
      hashContent(['role', 'Acme', 'Engineer', '2022-01']),
      hashContent(['role', 'Acme', 'Engineer', '2022-01']),
    );
  });

  test('spacing and case are still ignored, as every writer relies on', () => {
    assert.equal(hashContent(['Skill', ' Python  3 ']), hashContent(['skill', 'python 3']));
  });
});

suite('rows keyed by the old recipe cross over on the next sync', () => {
  /** What a row stored before the separator existed carries. */
  const oldRecipeHash = (name: string) =>
    createHash('sha256').update(['skill', name, 'tool'].join('').toLowerCase()).digest('hex').slice(0, 32);

  test('a stored row with an old hash is updated, not proposed a second time', () => {
    const stored = { ...storedSkill('Kubernetes'), contentHash: oldRecipeHash('Kubernetes') } as ProfileRecord;
    const plan = reconcile([stored], [parsedSkill('Kubernetes')]);
    assert.equal(plan.toInsert.length, 0, 'nothing proposed again');
    assert.equal(plan.toUpdate.length, 1, 'matched by identity and re-keyed');
    assert.equal(plan.toUpdate[0].id, stored.id);
  });

  test('and it is not flagged as having vanished from the portfolio', () => {
    const stored = { ...storedSkill('Kubernetes'), contentHash: oldRecipeHash('Kubernetes') } as ProfileRecord;
    assert.equal(reconcile([stored], [parsedSkill('Kubernetes')]).toFlag.length, 0, 'still there');
  });
});
