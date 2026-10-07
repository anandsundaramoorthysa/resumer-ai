/**
 * lib/server/approval.ts against a real Postgres engine: who is approved, who may be decided
 * for, and what a pending account is sent to.
 *
 * `@/auth` is the session stand-in (tests/db/auth-stub.mts); `redirect()` is the real one —
 * it throws a NEXT_REDIRECT error whose digest names the target, which is what the pages see.
 */
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { setSession } from './db/auth-stub.mjs';
import { mkUser, one } from './db/seed.mjs';
import { accountsForReview, approvalFor, decide, isOwnerSession, requireApprovedUser } from '../lib/server/approval';
import { recordConsent } from '../lib/legal/consent';

// Read lazily (and cached per process) by lib/ai/daily-budget.ts, so setting it here is early enough.
process.env.OWNER_EMAILS = 'owner@example.test';

const t = await installTestDb();
const { pg } = t;

const owner = await mkUser(pg, 'owner-1', { email: 'owner@example.test', verified: true, approval: 'pending' });
const impostor = await mkUser(pg, 'impostor-1', { email: 'owner@example.test.evil', verified: false });
const pendingUser = await mkUser(pg, 'pending-1', { email: 'p@example.test', approval: 'pending' });
const approvedUser = await mkUser(pg, 'approved-1', { email: 'a@example.test', approval: 'approved' });
const deniedUser = await mkUser(pg, 'denied-1', { email: 'd@example.test', approval: 'denied' });

/** The redirect target of a call that is expected to redirect. */
async function redirectedTo(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? '';
    return digest.startsWith('NEXT_REDIRECT') ? digest.split(';')[2] : `error:${String(e)}`;
  }
}

await suiteAsync('approval: who is approved', async () => {
  await testAsync('an owner is always approved, whatever the column says', async () => {
    assert.equal(await approvalFor(owner), 'approved');
  });
  await testAsync('approved and denied are reported as stored', async () => {
    assert.equal(await approvalFor(approvedUser), 'approved');
    assert.equal(await approvalFor(deniedUser), 'denied');
  });
  await testAsync('pending, an unknown id, and an unrecognised value all read as pending', async () => {
    assert.equal(await approvalFor(pendingUser), 'pending');
    assert.equal(await approvalFor('no-such-user'), 'pending');
    await pg.query(`update "user" set approval = 'bogus' where id = $1`, [impostor]);
    assert.equal(await approvalFor(impostor), 'pending');
  });
});

await suiteAsync('approval: the owner session', async () => {
  await testAsync('a verified listed address is the owner', async () => {
    assert.equal(await isOwnerSession({ user: { id: owner } } as never), true);
  });
  await testAsync('an unverified or unlisted account is not, and neither is no session', async () => {
    assert.equal(await isOwnerSession({ user: { id: pendingUser } } as never), false);
    assert.equal(await isOwnerSession({ user: { id: 'ghost' } } as never), false);
    assert.equal(await isOwnerSession(null), false);
    await pg.query(`update "user" set "emailVerified" = null where id = $1`, [owner]);
    assert.equal(await isOwnerSession({ user: { id: owner } } as never), false, 'unverified: a claim, not proof');
    await pg.query(`update "user" set "emailVerified" = now() where id = $1`, [owner]);
  });
});

await suiteAsync('approval: deciding', async () => {
  await testAsync('decide() refuses to decide for an owner account', async () => {
    assert.equal(await decide(owner, 'denied'), null);
    assert.equal((await one<{ approval: string }>(pg, `select approval from "user" where id=$1`, [owner]))?.approval, 'pending');
  });
  await testAsync('decide() on an unknown id returns null', async () => {
    assert.equal(await decide('ghost', 'approved'), null);
  });
  await testAsync('decide() stores the decision and a timestamp, and returns the address', async () => {
    const r = await decide(pendingUser, 'approved');
    assert.deepEqual(r, { email: 'p@example.test' });
    const row = await one<{ approval: string; approval_decided_at: Date | null }>(pg, `select approval, approval_decided_at from "user" where id=$1`, [pendingUser]);
    assert.equal(row?.approval, 'approved');
    assert.ok(row?.approval_decided_at);
  });
  await testAsync('accountsForReview lists pending and decided accounts, never an owner', async () => {
    const fresh = await mkUser(pg, 'pending-2', { email: 'p2@example.test', approval: 'pending' });
    const r = await accountsForReview();
    assert.ok(r.pending.some((a) => a.id === fresh));
    assert.ok(!r.pending.some((a) => a.id === owner), 'owner is filtered out');
    assert.ok(r.decided.some((a) => a.id === pendingUser));
    assert.ok(!r.decided.some((a) => a.id === fresh));
  });
});

await suiteAsync('approval: requireApprovedUser', async () => {
  await testAsync('no session -> /sign-in', async () => {
    setSession(null);
    assert.equal(await redirectedTo(requireApprovedUser), '/sign-in');
  });
  await testAsync('a session without consent -> /consent (before approval is even looked at)', async () => {
    setSession({ user: { id: deniedUser } });
    assert.equal(await redirectedTo(requireApprovedUser), '/consent');
  });
  await testAsync('consented but pending or denied -> /pending', async () => {
    for (const id of [deniedUser, 'pending-2']) {
      await recordConsent(id, { ageAttested: true, source: 'signup' });
      setSession({ user: { id } });
      assert.equal(await redirectedTo(requireApprovedUser), '/pending', id);
    }
  });
  await testAsync('consented and approved -> the session comes back, no redirect', async () => {
    await recordConsent(approvedUser, { ageAttested: true, source: 'signup' });
    setSession({ user: { id: approvedUser } });
    const s = (await requireApprovedUser()) as { user: { id: string } };
    assert.equal(s.user.id, approvedUser);
  });
  await testAsync('an owner with consent is let through even though the column says pending', async () => {
    await recordConsent(owner, { ageAttested: true, source: 'signup' });
    setSession({ user: { id: owner } });
    assert.equal(((await requireApprovedUser()) as { user: { id: string } }).user.id, owner);
  });
});

await t.close();
