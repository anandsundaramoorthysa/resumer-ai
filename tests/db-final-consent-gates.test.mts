/**
 * Consent is enforced everywhere an account can act, not just on pages that call
 * requireApprovedUser: the home page redirect, the AI choke point (assertDailyBudget, owner
 * included) and the radar handler gate. And /consent, deletion and export stay reachable
 * without it (no loop).
 */
import { readFileSync } from 'node:fs';
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { mkUser } from './db/seed.mjs';
import { requireConsentAndApproval } from '../lib/server/approval';
import { assertDailyBudget } from '../lib/ai/daily-budget';
import { recordConsent } from '../lib/legal/consent';
import { CONSENT_REQUIRED_MESSAGE } from '../lib/legal/config';
import { makeRadarHandlers } from '../lib/radar/handlers';

process.env.OWNER_EMAILS = 'owner@example.test';
const t = await installTestDb();
const { pg } = t;

const owner = await mkUser(pg, 'own', { email: 'owner@example.test', verified: true });
const noConsent = await mkUser(pg, 'nc', { email: 'nc@example.test', approval: 'approved' });
const pendingConsented = await mkUser(pg, 'pc', { email: 'pc@example.test', approval: 'pending' });
const good = await mkUser(pg, 'good', { email: 'g@example.test', approval: 'approved' });
for (const u of [pendingConsented, good]) await recordConsent(u, { ageAttested: true, source: 'signup' });

async function redirectedTo(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? '';
    return digest.startsWith('NEXT_REDIRECT') ? digest.split(';')[2] : `error:${String(e)}`;
  }
}

await suiteAsync('consent gates', async () => {
  await testAsync('home page helper: no consent -> /consent, then pending -> /pending, ok -> none', async () => {
    assert.equal(await redirectedTo(() => requireConsentAndApproval(noConsent)), '/consent');
    assert.equal(await redirectedTo(() => requireConsentAndApproval(pendingConsented)), '/pending');
    assert.equal(await redirectedTo(() => requireConsentAndApproval(good)), null);
  });

  await testAsync('assertDailyBudget refuses an approved account with no consent, with the user-safe sentence', async () => {
    await assert.rejects(
      () => assertDailyBudget(noConsent),
      (e: unknown) => (e as Error).name === 'BudgetExceededError' && (e as Error).message === CONSENT_REQUIRED_MESSAGE,
    );
  });

  await testAsync('the owner is not exempt from consent, only from quotas', async () => {
    await assert.rejects(() => assertDailyBudget(owner), (e: unknown) => (e as Error).message === CONSENT_REQUIRED_MESSAGE);
    await recordConsent(owner, { ageAttested: true, source: 'signup' });
    await assertDailyBudget(owner);
  });

  await testAsync('consent present: approval is still checked, and an approved account passes', async () => {
    await assert.rejects(() => assertDailyBudget(pendingConsented), (e: unknown) => /waiting for the site owner/.test((e as Error).message));
    await assertDailyBudget(good);
  });

  await testAsync('radar gate: 403 with the consent sentence before approval; nothing runs', async () => {
    let started = 0;
    let consented = false;
    const h = makeRadarHandlers({
      userId: async () => 'u',
      approval: async () => 'approved',
      consent: async () => consented,
      assertBurst: async () => {},
      credits: async () => ({}),
      start: async () => {
        started += 1;
        return {} as never;
      },
      advance: async () => ({}) as never,
      approve: async () => ({}) as never,
      select: async () => ({}) as never,
      cancel: async () => ({}) as never,
      get: async () => null,
      assertEnabled: async () => {},
    });
    const req = () =>
      new Request('https://a.example/api/radar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const r = await h.POST(req());
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: CONSENT_REQUIRED_MESSAGE });
    assert.equal((await h.GET(new Request('https://a.example/api/radar'))).status, 403);
    assert.equal(started, 0);
    consented = true;
    assert.equal((await h.POST(req())).status, 200);
  });

  await testAsync('/consent, deletion and export never call a consent gate (no loop, always reachable)', async () => {
    const gate = /requireApprovedUser|requireConsentAndApproval|assertDailyBudget|approvalFor/;
    for (const f of ['../app/consent/page.tsx', '../app/consent/actions.ts', '../app/settings/account/actions.ts', '../app/api/account/export/route.ts']) {
      assert(!gate.test(readFileSync(new URL(f, import.meta.url), 'utf8')), `${f} must not be gated`);
    }
  });
});
