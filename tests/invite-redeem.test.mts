/**
 * Invite redemption against a stub store that mimics the SQL guarantees: the claim is one
 * conditional step, and a thrown error rolls the whole transaction back.
 */
import { assert, suite, suiteAsync, test, testAsync } from './harness.mjs';
import {
  formatCode,
  generateCode,
  hashCode,
  istDayStart,
  normalizeCode,
  redeemInvite,
  type RedeemDeps,
  type RedeemTx,
} from '../lib/legal/invite-logic';

const NOW = new Date('2026-10-07T10:00:00Z');
const HOUR = 3_600_000;

interface Invite { id: string; hash: string; uses: number; max: number; disabled: boolean; expiresAt: Date | null }
interface State {
  invites: Invite[];
  redemptions: { inviteId: string | null; userId: string; at: Date }[];
  approval: Record<string, string>;
}

function makeStore(init: Partial<State> = {}, opts: { allow?: () => boolean } = {}) {
  const state: State = { invites: [], redemptions: [], approval: {}, ...init };
  const deps: RedeemDeps = {
    allow: async () => (opts.allow ? opts.allow() : true),
    transaction: async (fn) => {
      const snapshot = structuredClone(state);
      const tx: RedeemTx = {
        redemptionExists: async (u) => state.redemptions.some((r) => r.userId === u),
        redemptionsSince: async (since) => state.redemptions.filter((r) => r.at >= since).length,
        claimCode: async (hash, now) => {
          const inv = state.invites.find(
            (i) => i.hash === hash && !i.disabled && i.uses < i.max && (!i.expiresAt || i.expiresAt > now),
          );
          if (!inv) return null;
          inv.uses += 1;
          return inv.id;
        },
        insertRedemption: async (inviteId, userId, at) => {
          if (state.redemptions.some((r) => r.userId === userId)) throw new Error('unique violation');
          state.redemptions.push({ inviteId, userId, at });
        },
        approveUser: async (u) => {
          if (state.approval[u] !== 'pending') return false;
          state.approval[u] = 'approved';
          return true;
        },
      };
      try {
        return await fn(tx);
      } catch (err) {
        Object.assign(state, snapshot);
        throw err;
      }
    },
  };
  return { state, deps };
}

const CODE = 'ABCD2345EFGH';
const invite = (over: Partial<Invite> = {}): Invite => ({ id: 'i1', hash: hashCode(CODE), uses: 0, max: 1, disabled: false, expiresAt: null, ...over });
const base = { now: NOW, dailyQuota: 20 };

suite('code format', () => {
  test('generated codes are 12 Crockford characters and round-trip through formatting', () => {
    const c = generateCode();
    assert(/^[0-9A-HJKMNP-TV-Z]{12}$/.test(c), c);
    assert(normalizeCode(formatCode(c)) === c);
  });
  test('aliases and case are forgiven; junk is refused', () => {
    assert(normalizeCode('abcd-2345-efgh') === CODE);
    assert(normalizeCode('OOOO-IIII-LLLL') === '000011111111');
    assert(normalizeCode('too short') === null);
    assert(normalizeCode('ABCD2345EFGU') === null, 'U is not in the alphabet');
  });
  test('IST day starts at 18:30 UTC the previous day', () => {
    assert(istDayStart(new Date('2026-10-07T10:00:00Z')).toISOString() === '2026-10-06T18:30:00.000Z');
    assert(istDayStart(new Date('2026-10-07T19:00:00Z')).toISOString() === '2026-10-07T18:30:00.000Z');
  });
});

await suiteAsync('redeemInvite', async () => {
  await testAsync('a valid code approves a pending account and consumes one use', async () => {
    const { state, deps } = makeStore({ invites: [invite()], approval: { u1: 'pending' } });
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: 'abcd-2345-efgh' })) === 'approved');
    assert(state.approval.u1 === 'approved');
    assert(state.invites[0].uses === 1 && state.redemptions.length === 1);
  });

  await testAsync('unknown, malformed, disabled, expired and used-up codes are invalid and change nothing', async () => {
    for (const [name, inv] of [
      ['disabled', invite({ disabled: true })],
      ['expired', invite({ expiresAt: new Date(NOW.getTime() - HOUR) })],
      ['used up', invite({ uses: 1 })],
    ] as const) {
      const { state, deps } = makeStore({ invites: [inv], approval: { u1: 'pending' } });
      assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: CODE })) === 'invalid', name);
      assert(state.approval.u1 === 'pending' && state.redemptions.length === 0, name);
    }
    const { deps } = makeStore({ invites: [invite()], approval: { u1: 'pending' } });
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: 'ZZZZ-ZZZZ-ZZZZ' })) === 'invalid', 'unknown');
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: 'nope' })) === 'invalid', 'malformed');
  });

  await testAsync('an unexpired code works until its last second', async () => {
    const { deps } = makeStore({ invites: [invite({ expiresAt: new Date(NOW.getTime() + HOUR) })], approval: { u1: 'pending' } });
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: CODE })) === 'approved');
  });

  await testAsync('replay by the same user is refused and spends nothing', async () => {
    const { state, deps } = makeStore({ invites: [invite({ max: 5 })], approval: { u1: 'pending' } });
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: CODE })) === 'approved');
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: CODE })) === 'already');
    assert(state.invites[0].uses === 1);
  });

  await testAsync('a single-use code goes to exactly one of two simultaneous users', async () => {
    const { state, deps } = makeStore({ invites: [invite()], approval: { u1: 'pending', u2: 'pending' } });
    const results = await Promise.all([
      redeemInvite(deps, { ...base, userId: 'u1', rawCode: CODE }),
      redeemInvite(deps, { ...base, userId: 'u2', rawCode: CODE }),
    ]);
    assert(results.filter((r) => r === 'approved').length === 1, results.join());
    assert(results.filter((r) => r === 'invalid').length === 1, results.join());
    assert(state.invites[0].uses === 1);
  });

  await testAsync('over the daily quota nothing is consumed and the account stays pending', async () => {
    const { state, deps } = makeStore({
      invites: [invite({ max: 5 })],
      approval: { u1: 'pending', u2: 'pending' },
    });
    assert((await redeemInvite(deps, { ...base, dailyQuota: 1, userId: 'u1', rawCode: CODE })) === 'approved');
    assert((await redeemInvite(deps, { ...base, dailyQuota: 1, userId: 'u2', rawCode: CODE })) === 'at-capacity');
    assert(state.invites[0].uses === 1, 'the code was not spent');
    assert(state.approval.u2 === 'pending');
  });

  await testAsync('the quota resets at the next IST midnight, and yesterday does not count', async () => {
    const { deps } = makeStore({
      invites: [invite({ max: 5 })],
      approval: { u2: 'pending' },
      redemptions: [{ inviteId: 'i1', userId: 'u1', at: new Date('2026-10-06T18:00:00Z') }], // 23:30 IST on the 6th
    });
    assert((await redeemInvite(deps, { ...base, dailyQuota: 1, userId: 'u2', rawCode: CODE })) === 'approved');
  });

  await testAsync('a denied or already approved account is not changed, and the code is rolled back', async () => {
    const { state, deps } = makeStore({ invites: [invite()], approval: { u1: 'denied' } });
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: CODE })) === 'not-pending');
    assert(state.invites[0].uses === 0 && state.redemptions.length === 0, 'rolled back');
    assert(state.approval.u1 === 'denied');
  });

  await testAsync('open mode (no code) approves under quota and refuses over it', async () => {
    const { state, deps } = makeStore({ approval: { u1: 'pending', u2: 'pending' } });
    assert((await redeemInvite(deps, { ...base, dailyQuota: 1, userId: 'u1', rawCode: null })) === 'approved');
    assert((await redeemInvite(deps, { ...base, dailyQuota: 1, userId: 'u2', rawCode: null })) === 'at-capacity');
    assert(state.redemptions[0].inviteId === null);
  });

  await testAsync('rate limiting stops guessing before any lookup', async () => {
    let attempts = 0;
    const { state, deps } = makeStore({ invites: [invite()], approval: { u1: 'pending' } }, { allow: () => ++attempts <= 2 });
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: 'ZZZZ-ZZZZ-ZZZZ' })) === 'invalid');
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: 'YYYY-YYYY-YYYY' })) === 'invalid');
    assert((await redeemInvite(deps, { ...base, userId: 'u1', rawCode: CODE })) === 'rate-limited', 'even the right code');
    assert(state.approval.u1 === 'pending');
  });
});
