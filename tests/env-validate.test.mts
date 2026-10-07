/** lib/env.ts — names only, never throws. */

import { assert, suite, test } from './harness.mjs';
import { validateEnv } from '@/lib/env';

const full = {
  DATABASE_URL: 'postgres://u:p@h/db',
  AUTH_SECRET: 'x'.repeat(32),
  AUTH_GITHUB_ID: 'id',
  AUTH_GITHUB_SECRET: 'sec',
  TOKEN_ENC_KEY: 'k'.repeat(40),
  NEXT_PUBLIC_SITE_URL: 'https://app.example.com',
  GROQ_API_KEY: 'g',
};

suite('validateEnv', () => {
  test('empty env reports every required name and no values', () => {
    const r = validateEnv({});
    assert(!r.ok, 'not ok');
    for (const k of ['DATABASE_URL', 'AUTH_SECRET', 'TOKEN_ENC_KEY']) assert(r.missing.includes(k), k);
    assert(r.missing.some((m) => m.startsWith('one of GROQ')), 'needs a provider');
  });
  test('complete env is ok, optional gaps are warnings', () => {
    const r = validateEnv(full);
    assert(r.ok && r.missing.length === 0, 'ok');
    assert(r.warnings.includes('CRON_SECRET is not set'), 'cron warning');
  });
  test('blank values count as missing; secrets never echoed', () => {
    const r = validateEnv({ ...full, DATABASE_URL: '   ', AUTH_SECRET: 'zq9-xk' });
    assert(r.missing.includes('DATABASE_URL'), 'blank');
    assert(!JSON.stringify(r).includes('zq9-xk'), 'no value leak');
    assert(r.warnings.some((w) => w.includes('AUTH_SECRET')), 'short secret warned');
  });
});
