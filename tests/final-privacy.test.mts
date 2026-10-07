/** Notice/code agreement and ordering checks that need no database. */
import { readFileSync } from 'node:fs';
import { assert, suite, test } from './harness.mjs';
import { POLICY_VERSION } from '../lib/legal/config';
import { istDayStart as a } from '../lib/legal/invite-logic';
import { istDayStart as b } from '../lib/radar/runs';
import { istDayStart as c } from '../lib/time/ist';

const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');

suite('final: notice and wiring', () => {
  test('policy version bumped', () => assert.equal(POLICY_VERSION, '2026-10-08'));
  test('one IST helper, edge of the day', () => {
    assert.equal(a(new Date('2026-10-05T18:30:00Z')).getTime(), b(Date.parse('2026-10-05T18:30:00Z')).getTime());
    assert.equal(c(new Date('2026-10-05T18:29:59Z')).toISOString(), '2026-10-04T18:30:00.000Z');
    assert.equal(c(Date.parse('2026-10-05T18:30:00Z')).toISOString(), '2026-10-05T18:30:00.000Z');
  });
  test('privacy page no longer claims contact details never reach AI', () => {
    const p = src('../app/privacy/page.tsx') + src('../lib/legal/content.ts');
    assert(!/email address and phone number are not put into AI/.test(p));
    assert(/including your name, email address, phone number and links/.test(p));
    assert(/ai_call|aiCallDays/.test(src('../app/privacy/page.tsx')) || /aiCallDays/.test(src('../app/privacy/page.tsx')));
  });
  test('account deletion erases ai_call', () => assert(/tx\.delete\(aiCall\)/.test(src('../app/settings/account/actions.ts'))));
  test('invite redemption happens after emailVerified is written, not at signup', () => {
    const s = src('../app/sign-in/account-actions.ts');
    const signup = s.slice(0, s.indexOf('export async function verifyEmailAction'));
    assert(!/redeemForUser\(/.test(signup.replace(/import[^\n]*\n/g, '')), 'signup must not redeem');
    const verify = s.slice(s.indexOf('export async function verifyEmailAction'));
    assert(verify.indexOf('emailVerified: new Date()') < verify.indexOf('redeemForUser('));
  });
});
