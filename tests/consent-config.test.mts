import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoApproveDailyQuota, POLICY_VERSION, signupMode, TERMS_VERSION } from '../lib/legal/config';
import { approvalDeniedEmail, approvalGrantedEmail, inviteRedeemedPendingEmail } from '../lib/auth/templates';
import { formatDate, formatDateTime, formatInr } from '../lib/format';
import { assert, suite, test } from './harness.mjs';

const root = join(process.cwd());
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function setAll(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  setAll(vars);
  try {
    fn();
  } finally {
    setAll(saved);
  }
}

suite('signup mode and quota config', () => {
  test('SIGNUP_MODE defaults to invite and accepts only the known modes', () => {
    withEnv({ SIGNUP_MODE: undefined }, () => assert(signupMode() === 'invite'));
    withEnv({ SIGNUP_MODE: 'OPEN' }, () => assert(signupMode() === 'open'));
    withEnv({ SIGNUP_MODE: 'manual' }, () => assert(signupMode() === 'manual'));
    withEnv({ SIGNUP_MODE: 'anything' }, () => assert(signupMode() === 'invite'));
  });
  test('AUTO_APPROVE_DAILY_QUOTA defaults to 20; zero is a real value; junk falls back', () => {
    withEnv({ AUTO_APPROVE_DAILY_QUOTA: undefined }, () => assert(autoApproveDailyQuota() === 20));
    withEnv({ AUTO_APPROVE_DAILY_QUOTA: '0' }, () => assert(autoApproveDailyQuota() === 0));
    withEnv({ AUTO_APPROVE_DAILY_QUOTA: '5' }, () => assert(autoApproveDailyQuota() === 5));
    withEnv({ AUTO_APPROVE_DAILY_QUOTA: 'x' }, () => assert(autoApproveDailyQuota() === 20));
    withEnv({ AUTO_APPROVE_DAILY_QUOTA: '-3' }, () => assert(autoApproveDailyQuota() === 20));
  });
  test('versions are set', () => assert(POLICY_VERSION && TERMS_VERSION));
});

suite('legal pages are static and consent is enforced server-side', () => {
  for (const p of ['privacy', 'terms', 'contact', 'accessibility']) {
    test(`/${p} makes no auth call, has metadata, one h1 via the shell`, () => {
      const src = read(`app/${p}/page.tsx`);
      assert(!/@\/auth|auth\(\)/.test(src), 'must not call auth');
      assert(/export const metadata/.test(src));
      assert(!/<h1/.test(src), 'the h1 comes from LegalShell only');
    });
  }
  test('the shell has exactly one h1, a focusable main#main and the theme corner', () => {
    const src = read('components/legal-shell.tsx');
    assert((src.match(/<h1/g) ?? []).length === 1);
    assert(/<main id="main" tabIndex=\{-1\}/.test(src) && /<ThemeCorner/.test(src));
  });
  test('sign-up refuses without the attestation, and requireApprovedUser gates on consent', () => {
    assert(/consent\.accepted !== true/.test(read('app/sign-in/account-actions.ts')));
    assert(/hasCurrentConsent/.test(read('lib/server/approval.ts')) && /redirect\('\/consent'\)/.test(read('lib/server/approval.ts')));
  });
  test('the consent page checks consent but never approval, so it cannot loop with /pending', () => {
    const src = read('app/consent/page.tsx');
    assert(!/approvalFor|requireApprovedUser/.test(src));
  });
  test('robots disallows the authenticated routes and keeps the legal pages crawlable', () => {
    const src = read('app/robots.ts');
    for (const r of ['/radar', '/resume', '/activity', '/import', '/profile', '/applications', '/settings', '/admin', '/api', '/consent', '/pending'])
      assert(src.includes(`'${r}`), r);
    for (const r of ['/privacy', '/terms', '/contact', '/accessibility']) assert(src.includes(`'${r}'`), r);
  });
});

suite('email templates', () => {
  test('each has subject, text and html; html carries no remote images or scripts; text has the link', () => {
    const mails = [approvalGrantedEmail('https://x.test/sign-in'), approvalDeniedEmail('https://x.test/settings/account'), inviteRedeemedPendingEmail()];
    for (const m of mails) {
      assert(m.subject && m.text && m.html.startsWith('<!doctype html>'));
      assert(!/<img|<script|src=|url\(/i.test(m.html), 'no remote content');
      assert(/lang="en"/.test(m.html));
    }
    assert(mails[0].text.includes('https://x.test/sign-in'));
  });
  test('html escapes interpolated values', () => {
    const m = approvalGrantedEmail('https://x.test/?a=1&b="<x>');
    assert(!m.html.includes('"<x>') && m.html.includes('&amp;b=&quot;&lt;x&gt;'));
  });
});

suite('India formatting', () => {
  test('dates are in IST and the zone is named', () => {
    assert(formatDateTime(new Date('2026-10-07T20:00:00Z')) === '8 Oct, 01:30 IST', formatDateTime(new Date('2026-10-07T20:00:00Z')));
    assert(formatDate(new Date('2026-10-07T20:00:00Z')) === '8 Oct 2026', formatDate(new Date('2026-10-07T20:00:00Z')));
  });
  test('rupees use lakh grouping', () => {
    assert(formatInr(1234567).replace(/\s/g, '') === '₹12,34,567', formatInr(1234567));
  });
});
