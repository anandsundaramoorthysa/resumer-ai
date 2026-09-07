/**
 * The auth primitives: hashing, strength, and which addresses are allowed in.
 *
 * The flows themselves (sign-up, verification, reset, rate limits) touch the database
 * and are covered by scripts/verify-auth.mts against a real one. What is pinned here is
 * everything pure — and in particular the two properties that are silent when broken: a
 * hash that verifies a wrong password, and a normaliser that lets one inbox hold several
 * accounts.
 */

import { hashPassword, verifyPassword } from '../lib/auth/password';
import { checkPassword, MIN_PASSWORD_LENGTH } from '../lib/auth/password-rules';
import {
  checkEmailOffline,
  domainOf,
  isDisposableDomain,
  normalizeEmail,
} from '../lib/auth/email-policy';
import { hashToken } from '../lib/auth/tokens';
import { suite, test, assert } from './harness.mjs';

suite('password hashing', () => {
  test('a password verifies against its own hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert(await verifyPassword('correct horse battery staple', hash), 'the right password passes');
  });

  test('a wrong password does not', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert(!(await verifyPassword('correct horse battery stapl', hash)), 'one character short fails');
    assert(!(await verifyPassword('', hash)), 'and empty fails');
  });

  test('the same password hashes differently every time', async () => {
    const a = await hashPassword('the same password');
    const b = await hashPassword('the same password');
    assert(a !== b, 'salted, so two users with one password do not look alike in a dump');
    assert(await verifyPassword('the same password', b), 'and both still verify');
  });

  test('the hash carries its own parameters', async () => {
    const hash = await hashPassword('anything at all');
    const [scheme, n, r, p] = hash.split('$');
    assert(scheme === 'scrypt', 'named scheme');
    assert(Number(n) >= 16384, `cost recorded and not trivial, got ${n}`);
    assert(Number(r) > 0 && Number(p) > 0, 'and the rest of the parameters too');
  });

  test('a malformed stored hash fails rather than throwing', async () => {
    for (const junk of ['', 'not-a-hash', 'scrypt$$$$', 'bcrypt$1$2$3$4$5', 'scrypt$1$1$1$$']) {
      assert(!(await verifyPassword('anything', junk)), `handled: ${JSON.stringify(junk)}`);
    }
  });

  test('unicode normalisation means one password, one hash', async () => {
    // The same visible password typed on two keyboards: one sends a precomposed e-acute,
    // the other sends "e" followed by a combining accent. Without normalisation these are
    // different byte strings, and the user is locked out of their own account by their
    // choice of input method.
    const composed: string = 'café-password-2026';
    const decomposed: string = 'café-password-2026';
    assert(composed !== decomposed, 'the two really are different byte strings');

    const hash = await hashPassword(composed);
    assert(await verifyPassword(decomposed, hash), 'typed either way, it is the same password');
  });
});

suite('password strength', () => {
  test('a long passphrase passes', () => {
    assert(checkPassword('mist over the harbour wall').ok, 'length is what matters');
  });

  test('too short is refused, whatever it contains', () => {
    const r = checkPassword('Aa1!xY2@');
    assert(!r.ok, 'eight characters of variety is still eight characters');
    assert(r.problems.some((p) => p.includes(String(MIN_PASSWORD_LENGTH))), 'and it says how many are needed');
  });

  test('the passwords people actually try are named', () => {
    assert(!checkPassword('password123').ok, 'top of every list');
    assert(!checkPassword('qwertyuiop').ok, 'a keyboard row');
    assert(!checkPassword('aaaaaaaaaaaa').ok, 'one character repeated');
  });

  test('a password containing the email address is refused', () => {
    const r = checkPassword('anandsundar2026', 'anandsundar@example.com');
    assert(!r.ok, 'the first thing anyone would try');
    assert(r.problems.some((p) => p.includes('email')), `and it says why: ${r.problems.join(' ')}`);
  });

  test('a short local part cannot poison an unrelated password', () => {
    // "an@example.com" must not reject every password containing "an".
    assert(checkPassword('mist over the harbour wall', 'an@example.com').ok, 'no false rejection');
  });

  test('no composition rule is imposed', () => {
    assert(checkPassword('all lowercase words here').ok, 'no forced symbol or digit');
  });
});

suite('email policy', () => {
  test('gmail aliasing collapses to one address', () => {
    assert(
      normalizeEmail('An.and+jobs@Gmail.com') === 'anand@gmail.com',
      `dots and plus tags are not distinct inboxes at Gmail, got ${normalizeEmail('An.and+jobs@Gmail.com')}`,
    );
    assert(normalizeEmail('a.n.a.n.d@googlemail.com') === 'anand@gmail.com', 'googlemail is gmail');
  });

  test('dots elsewhere are left alone, because elsewhere they matter', () => {
    assert(
      normalizeEmail('first.last@company.com') === 'first.last@company.com',
      'stripping these would merge two different people',
    );
    assert(normalizeEmail('first.last+jobs@company.com') === 'first.last@company.com', 'plus tags still go');
  });

  test('disposable domains are refused, subdomains included', () => {
    assert(isDisposableDomain('mailinator.com'), 'a known one');
    assert(isDisposableDomain('anything.mailinator.com'), 'and the subdomains it hands out');
    assert(!isDisposableDomain('gmail.com'), 'a real provider is not one');
    assert(!isDisposableDomain('anandsundaramoorthy.com'), 'nor is a personal domain');
  });

  test('the refusal explains itself in terms of the user, not the policy', () => {
    const r = checkEmailOffline('someone@yopmail.com');
    assert(!r.ok, 'refused');
    assert(r.reason!.includes('next year'), `the reason is about their profile: ${r.reason}`);
  });

  test('malformed addresses are refused', () => {
    for (const bad of ['', 'no-at-sign', 'two@@at.com', 'trailing@dot.', '@nolocal.com', 'spaces in@it.com']) {
      assert(!checkEmailOffline(bad).ok, `refused: ${JSON.stringify(bad)}`);
    }
  });

  test('an ordinary address passes', () => {
    const r = checkEmailOffline('  Anand@Example.COM ');
    assert(r.ok, 'accepted');
    assert(r.normalized === 'anand@example.com', 'trimmed and lower-cased for storage');
  });

  test('the domain is read from the last @, not the first', () => {
    assert(domainOf('a@b@example.com') === 'example.com', 'quoted local parts may contain @');
  });
});

suite('link tokens', () => {
  test('the stored value is a hash, not the token', () => {
    const token = 'a-token-that-would-reset-an-account';
    const stored = hashToken(token);
    assert(stored !== token, 'a database dump contains no usable link');
    assert(/^[0-9a-f]{64}$/.test(stored), `sha-256 hex, got ${stored}`);
  });

  test('hashing is deterministic, so a link can be looked up', () => {
    assert(hashToken('same') === hashToken('same'), 'same in, same out');
    assert(hashToken('same') !== hashToken('other'), 'different in, different out');
  });
});
