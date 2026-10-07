/**
 * rateLimit() against a real Postgres engine.
 *
 * Mutation testing found that none of the seven operators and boundaries in `rateLimit`
 * were pinned by any test: the function reads and writes the database, and no suite had one.
 * Every assertion below sits on a specific edge — the `>` against `max`, the two window
 * cut-offs, `record: false`, the `email:` / `ip:` bucket namespaces, the missing-IP branch.
 */
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { authAttempts } from '../lib/db/schema';
import { LIMITS, clearAttempts, purgeOldAttempts, rateLimit, type AuthAction } from '../lib/auth/rate-limit';

const t = await installTestDb();
const { db, pg } = t;

const count = async (subject: string, action: string) =>
  (await pg.query<{ n: number }>(`select count(*)::int as n from auth_attempt where subject = $1 and action = $2`, [subject, action])).rows[0].n;
const reset = async () => void (await pg.exec('delete from auth_attempt'));
/** Seed `n` attempts that happened `agoMs` ago. */
const seed = async (subject: string, action: AuthAction, n: number, agoMs: number) => {
  const at = new Date(Date.now() - agoMs);
  await db.insert(authAttempts).values(Array.from({ length: n }, () => ({ subject, action, createdAt: at })));
};

await suiteAsync('rateLimit: the ceiling', async () => {
  await testAsync('allows exactly `max` attempts and refuses the next (strict >, not >=)', async () => {
    await reset();
    const { max } = LIMITS['sign-in'].subject;
    for (let i = 1; i <= max; i++) {
      assert.equal((await rateLimit('sign-in', 'a@x.test', null)).allowed, true, `attempt ${i} of ${max}`);
    }
    const over = await rateLimit('sign-in', 'a@x.test', null);
    assert.equal(over.allowed, false);
    assert.match(over.message ?? '', /Too many attempts/);
    assert.doesNotMatch(over.message ?? '', /\d/, 'the message must not leak a number');
  });

  await testAsync('a refused attempt is still recorded, so a caller over the limit keeps accumulating', async () => {
    await reset();
    const { max } = LIMITS['sign-in'].subject;
    for (let i = 0; i < max + 3; i++) await rateLimit('sign-in', 'b@x.test', null);
    assert.equal(await count('email:b@x.test', 'sign-in'), max + 3);
  });

  await testAsync('the per-IP ceiling is separate and has its own message', async () => {
    await reset();
    const { max } = LIMITS['sign-in'].ip;
    for (let i = 1; i <= max; i++) {
      // A different address every time, so only the IP bucket can fill.
      assert.equal((await rateLimit('sign-in', `u${i}@x.test`, '203.0.113.9')).allowed, true, `ip attempt ${i}`);
    }
    const over = await rateLimit('sign-in', 'fresh@x.test', '203.0.113.9');
    assert.equal(over.allowed, false);
    assert.match(over.message ?? '', /from this connection/);
  });

  await testAsync('the subject check runs first: both over -> the address message', async () => {
    await reset();
    await seed('email:c@x.test', 'sign-in', LIMITS['sign-in'].subject.max, 1000);
    await seed('ip:203.0.113.10', 'sign-in', LIMITS['sign-in'].ip.max, 1000);
    const v = await rateLimit('sign-in', 'c@x.test', '203.0.113.10');
    assert.equal(v.allowed, false);
    assert.doesNotMatch(v.message ?? '', /connection/);
  });

  await testAsync('each action uses its own ceiling (sign-up allows 3, not 8)', async () => {
    await reset();
    for (let i = 0; i < 3; i++) assert.equal((await rateLimit('sign-up', 'd@x.test', null)).allowed, true);
    assert.equal((await rateLimit('sign-up', 'd@x.test', null)).allowed, false);
  });
});

await suiteAsync('rateLimit: what it records', async () => {
  await testAsync('records one subject row and one ip row, under the email:/ip: namespaces', async () => {
    await reset();
    await rateLimit('verify', 'e@x.test', '198.51.100.7');
    assert.equal(await count('email:e@x.test', 'verify'), 1);
    assert.equal(await count('ip:198.51.100.7', 'verify'), 1);
    assert.equal(await count('e@x.test', 'verify'), 0, 'no un-namespaced row');
  });

  await testAsync('no IP -> only the subject row, and the IP branch is skipped', async () => {
    await reset();
    await rateLimit('verify', 'f@x.test', null);
    const total = (await pg.query<{ n: number }>('select count(*)::int as n from auth_attempt')).rows[0].n;
    assert.equal(total, 1);
  });

  await testAsync('record:false reads without adding', async () => {
    await reset();
    const { max } = LIMITS['sign-in'].subject;
    await seed('email:g@x.test', 'sign-in', max, 1000);
    const before = await count('email:g@x.test', 'sign-in');
    const v = await rateLimit('sign-in', 'g@x.test', '198.51.100.8', { record: false });
    assert.equal(v.allowed, true, 'exactly at max is still allowed; record:false must not push it over');
    assert.equal(await count('email:g@x.test', 'sign-in'), before);
    assert.equal(await count('ip:198.51.100.8', 'sign-in'), 0);
  });

  await testAsync('record:false still refuses a subject that is already over', async () => {
    await reset();
    await seed('email:h@x.test', 'sign-in', LIMITS['sign-in'].subject.max + 1, 1000);
    assert.equal((await rateLimit('sign-in', 'h@x.test', null, { record: false })).allowed, false);
  });

  await testAsync('record:true (explicit) and the default both record', async () => {
    await reset();
    await rateLimit('verify', 'i@x.test', null, { record: true });
    await rateLimit('verify', 'i@x.test', null, {});
    assert.equal(await count('email:i@x.test', 'verify'), 2);
  });
});

await suiteAsync('rateLimit: windows and isolation', async () => {
  await testAsync('attempts older than the window are not counted', async () => {
    await reset();
    const { max, windowMs } = LIMITS['sign-in'].subject;
    await seed('email:j@x.test', 'sign-in', max + 5, windowMs + 60_000);
    assert.equal((await rateLimit('sign-in', 'j@x.test', null)).allowed, true);
  });

  await testAsync('attempts just inside the window are counted', async () => {
    await reset();
    const { max, windowMs } = LIMITS['sign-in'].subject;
    await seed('email:k@x.test', 'sign-in', max, windowMs - 60_000);
    assert.equal((await rateLimit('sign-in', 'k@x.test', null)).allowed, false);
  });

  await testAsync('the IP window is its own: old ip rows are ignored, fresh ones are not', async () => {
    await reset();
    const { max, windowMs } = LIMITS['sign-in'].ip;
    await seed('ip:192.0.2.1', 'sign-in', max + 5, windowMs + 60_000);
    assert.equal((await rateLimit('sign-in', 'l@x.test', '192.0.2.1')).allowed, true);
    await reset();
    await seed('ip:192.0.2.2', 'sign-in', max, windowMs - 60_000);
    assert.equal((await rateLimit('sign-in', 'm@x.test', '192.0.2.2')).allowed, false);
  });

  await testAsync('a different subject is unaffected', async () => {
    await reset();
    await seed('email:n@x.test', 'sign-in', LIMITS['sign-in'].subject.max + 5, 1000);
    assert.equal((await rateLimit('sign-in', 'other@x.test', null)).allowed, true);
  });

  await testAsync('a different action is unaffected', async () => {
    await reset();
    await seed('email:o@x.test', 'sign-in', LIMITS['sign-in'].subject.max + 5, 1000);
    assert.equal((await rateLimit('verify', 'o@x.test', null)).allowed, true);
  });

  await testAsync('an address string that looks like an ip bucket cannot collide with it', async () => {
    await reset();
    await seed('ip:192.0.2.3', 'sign-in', LIMITS['sign-in'].ip.max + 5, 1000);
    // The subject "192.0.2.3" lives in email:192.0.2.3, a different bucket from ip:192.0.2.3.
    assert.equal((await rateLimit('sign-in', '192.0.2.3', null)).allowed, true);
  });
});

await suiteAsync('clearAttempts and purgeOldAttempts', async () => {
  await testAsync('clearAttempts clears one subject+action only', async () => {
    await reset();
    await seed('email:p@x.test', 'sign-in', 4, 1000);
    await seed('email:p@x.test', 'verify', 2, 1000);
    await seed('email:q@x.test', 'sign-in', 3, 1000);
    await seed('ip:192.0.2.4', 'sign-in', 5, 1000);
    await clearAttempts('sign-in', 'p@x.test');
    assert.equal(await count('email:p@x.test', 'sign-in'), 0);
    assert.equal(await count('email:p@x.test', 'verify'), 2);
    assert.equal(await count('email:q@x.test', 'sign-in'), 3);
    assert.equal(await count('ip:192.0.2.4', 'sign-in'), 5);
  });

  await testAsync('purgeOldAttempts drops rows older than two days and keeps the rest', async () => {
    await reset();
    await seed('email:r@x.test', 'sign-in', 2, 3 * 24 * 3_600_000);
    await seed('email:r@x.test', 'verify', 3, 24 * 3_600_000);
    await purgeOldAttempts();
    assert.equal(await count('email:r@x.test', 'sign-in'), 0);
    assert.equal(await count('email:r@x.test', 'verify'), 3);
  });

  await testAsync('every AuthAction has a limit row (no action is silently unlimited)', async () => {
    const actions: AuthAction[] = ['sign-in', 'sign-up', 'reset-request', 'verify', 'set-password', 'ai', 'ai-owner', 'ai-sync', 'ai-sync-owner'];
    for (const a of actions) {
      assert.ok(LIMITS[a].subject.max > 0 && LIMITS[a].subject.windowMs > 0, a);
      assert.ok(LIMITS[a].ip.max >= LIMITS[a].subject.max, `${a}: ip ceiling is not tighter than the account's`);
    }
  });
});

await t.close();
