/** Kill switches wired into radar handlers, the AI budget choke point and invite redemption. */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { assert, suiteAsync, testAsync } from './harness.mjs';
import { makeRadarHandlers } from '@/lib/radar/handlers';
import { assertDailyBudget, AI_PAUSED_MESSAGE } from '@/lib/ai/daily-budget';
import { redeemInvite, REDEEM_MESSAGES, type RedeemDeps } from '@/lib/legal/invite-logic';

// The libraries under test load flags through tsx's CJS registry; take the same instance (an ESM import is a second copy).
const { __resetFlags } = createRequire(import.meta.url)('../lib/server/flags') as typeof import('../lib/server/flags');

const { BudgetExceededError } = createRequire(import.meta.url)('../lib/ai/budget') as typeof import('../lib/ai/budget');
const { userMessage } = createRequire(import.meta.url)('../lib/server/user-message') as typeof import('../lib/server/user-message');

let reached = 0;
const handlers = (extra: object = {}) =>
  makeRadarHandlers({
    userId: async () => 'u1',
    approval: async () => 'approved',
    assertBurst: async () => {},
    credits: async () => ({ left: 1 }),
    start: async () => {
      reached += 1;
      return { runId: 'r' } as never;
    },
    advance: async () => ({}) as never,
    approve: async () => ({}) as never,
    select: async () => ({}) as never,
    cancel: async () => ({}) as never,
    get: async () => null,
    ...extra,
  });

const post = (h: ReturnType<typeof handlers>) =>
  h.POST(
    new Request('https://app.example.com/api/radar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
const get = (h: ReturnType<typeof handlers>) => h.GET(new Request('https://app.example.com/api/radar'));

await suiteAsync('wiring: kill switches', async () => {
  await testAsync('radar_enabled off -> 503 with the paused sentence on GET and POST, nothing runs', async () => {
    __resetFlags(async () => new Map([['radar_enabled', 'false']]));
    reached = 0;
    const h = handlers();
    const [g, p] = [await get(h), await post(h)];
    assert(g.status === 503 && p.status === 503, `${g.status} ${p.status}`);
    const body = (await p.json()) as { error: string };
    assert(body.error === 'Job Radar is paused for maintenance. Try again later.', body.error);
    assert(reached === 0, 'start() must not run');
  });

  await testAsync('radar_enabled: signed-out stays 401, flag on works, DB error fails open', async () => {
    __resetFlags(async () => new Map([['radar_enabled', 'false']]));
    assert((await get(handlers({ userId: async () => null }))).status === 401, '401 first');
    __resetFlags(async () => new Map());
    assert((await post(handlers())).status === 200, 'on');
    __resetFlags(async () => {
      throw new Error('connection refused');
    });
    assert((await post(handlers())).status === 200, 'fail open');
    __resetFlags();
  });

  await testAsync('radar_enabled via env override (works with the DB down)', async () => {
    __resetFlags(async () => {
      throw new Error('down');
    });
    process.env.FLAG_RADAR_ENABLED = 'off';
    const r = await get(handlers());
    delete process.env.FLAG_RADAR_ENABLED;
    assert(r.status === 503, `${r.status}`);
    __resetFlags();
  });

  await testAsync('ai_enabled off: assertDailyBudget refuses first with a user-safe sentence', async () => {
    __resetFlags(async () => new Map([['ai_enabled', 'false']]));
    let err: unknown;
    try {
      await assertDailyBudget('u1');
    } catch (e) {
      err = e;
    }
    assert(err instanceof BudgetExceededError, 'routes already map this class');
    assert((err as Error).message === 'AI features are paused for maintenance.', (err as Error).message);
    assert(userMessage(err, 'fallback') === AI_PAUSED_MESSAGE, 'shown to the user as-is');
    __resetFlags();
  });

  await testAsync('signups_enabled off: redeemInvite refuses before touching anything', async () => {
    let touched = false;
    const deps: RedeemDeps = {
      signupsOpen: async () => false,
      allow: async () => {
        touched = true;
        return true;
      },
      transaction: async () => {
        touched = true;
        throw new Error('should not run');
      },
    };
    const status = await redeemInvite(deps, { userId: 'u', rawCode: null, now: new Date(), dailyQuota: 5 });
    assert(status === 'paused' && !touched, status);
    assert(REDEEM_MESSAGES.paused === 'New sign-ups are paused.', 'copy');
  });

  await testAsync('signUpAction checks the flag and answers with the paused sentence', async () => {
    const src = readFileSync(new URL('../app/sign-in/account-actions.ts', import.meta.url), 'utf8');
    assert(/flagOn\('signups_enabled'\)[\s\S]{0,120}REDEEM_MESSAGES\.paused/.test(src), 'wired');
  });
});
