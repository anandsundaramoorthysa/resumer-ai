/** Robots, flag value validation, the sign-up time floor, id pattern. */
import { suiteAsync, testAsync, assert } from './harness.mjs';
import * as robotsMod from '../app/robots';

// tsx's CJS interop can wrap the default export once more.
const d = robotsMod.default as unknown;
const robots = (typeof d === 'function' ? d : (d as { default: typeof robotsMod.default }).default) as typeof robotsMod.default;
import { FlagValueError, validateFlagValue } from '../lib/server/flags';
import { holdUntilFloor } from '../lib/server/timing';
import { isSafeId, readJsonLimited } from '../lib/server/request-guard';

await suiteAsync('robots.txt', async () => {
  await testAsync('keeps token pages out of the index and sign-in stays crawlable', async () => {
    const rule = (robots().rules as Array<{ allow: string[]; disallow: string[] }>)[0];
    for (const p of ['/reset-password', '/verify-email', '/set-password', '/api/', '/pending']) {
      assert.ok(rule.disallow.includes(p), `${p} should be disallowed`);
    }
    assert.ok(!rule.disallow.includes('/sign-in'));
    assert.ok(!rule.disallow.includes('/'));
  });
});

await suiteAsync('flag values are validated per key', async () => {
  const bad = (k: Parameters<typeof validateFlagValue>[0], v: string) => {
    try {
      validateFlagValue(k, v);
    } catch (e) {
      return e instanceof FlagValueError;
    }
    return false;
  };
  await testAsync('booleans accept only true/false', async () => {
    assert.equal(validateFlagValue('radar_enabled', ' true '), 'true');
    assert.equal(validateFlagValue('ai_enabled', 'false'), 'false');
    for (const v of ['yes', '0', 'off', 'TRUE', '', 'true; drop']) assert.ok(bad('signups_enabled', v), v);
  });
  await testAsync('maintenance_message: plain text up to 300 chars', async () => {
    assert.equal(validateFlagValue('maintenance_message', '  Back at 5pm.  '), 'Back at 5pm.');
    assert.equal(validateFlagValue('maintenance_message', ''), '');
    assert.ok(bad('maintenance_message', 'x'.repeat(301)));
    assert.ok(bad('maintenance_message', '<script>alert(1)</script>'));
    assert.ok(bad('maintenance_message', 'a\u0000b'));
    assert.equal(validateFlagValue('maintenance_message', 'x'.repeat(300)).length, 300);
  });
});

await suiteAsync('timing floor and request helpers', async () => {
  await testAsync('fast and slow work both finish at the floor; work past it is not delayed', async () => {
    const run = async (workMs: number) => {
      const started = Date.now();
      await new Promise((r) => setTimeout(r, workMs));
      await holdUntilFloor(started, 300);
      return Date.now() - started;
    };
    const fast = await run(20);
    const slower = await run(150);
    const over = await run(400);
    assert.ok(fast >= 295 && fast < 380, `fast ${fast}`);
    assert.ok(slower >= 295 && slower < 380, `slower ${slower}`);
    assert.ok(Math.abs(fast - slower) < 60, `${fast} vs ${slower}`);
    assert.ok(over >= 395 && over < 480, `over ${over}`);
  });
  await testAsync('isSafeId rejects NUL, slashes, empty and long ids', async () => {
    assert.ok(isSafeId('abc-123_X') && isSafeId('3f2b8c1e-aaaa-bbbb-cccc-0123456789ab'));
    for (const v of ['', 'a\u0000b', '../x', 'a b', 'x'.repeat(65), undefined, 5]) assert.ok(!isSafeId(v), String(v));
  });
  await testAsync('readJsonLimited: empty -> {}, bad -> 400, big -> 413', async () => {
    const mk = (body: string) => new Request('http://localhost/x', { method: 'POST', body });
    const empty = await readJsonLimited(new Request('http://localhost/x', { method: 'POST' }), 100);
    assert.ok(empty.ok && JSON.stringify(empty.value) === '{}');
    const badJson = await readJsonLimited(mk('{x'), 100);
    assert.ok(!badJson.ok && badJson.res.status === 400);
    const big = await readJsonLimited(mk('"' + 'a'.repeat(200) + '"'), 100);
    assert.ok(!big.ok && big.res.status === 413);
  });
});
