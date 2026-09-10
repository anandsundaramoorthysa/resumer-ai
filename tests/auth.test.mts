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
import { linkedAccountPatch } from '../lib/auth/account-linking';
import {
  initialPasswordVerdict,
  needsInitialPassword,
} from '../lib/auth/initial-password';
import { sessionSurvivesReset } from '../lib/auth/session-validity';
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

/**
 * Pre-hijack account takeover, the rule that prevents it.
 *
 * Sign-up writes a row for any address that has no row yet, holding the submitted
 * password with `emailVerified` null. Inert on its own, because `authorize()` refuses an
 * unverified row. The danger is a row created by one person and verified by another: an
 * attacker signs up as an address they do not own and never opens the mail, the real
 * owner later signs in with Google or GitHub, account linking matches by email, and
 * verifying the row would hand the attacker's password the last gate it was missing.
 *
 * Both directions are pinned here, because getting either wrong is serious — one is
 * account takeover, the other locks every user who adds a provider out of the password
 * they already proved.
 */
suite('account linking and the password it may not bless', () => {
  test('an unverified row loses its password when a provider verifies it', () => {
    const patch = linkedAccountPatch(null);
    assert.equal(patch.passwordHash, null, 'the password nobody proved must be discarded');
    assert.ok(patch.emailVerified instanceof Date, 'and the address is still verified');
  });

  test('undefined is treated the same as never verified', () => {
    assert.equal(linkedAccountPatch(undefined).passwordHash, null);
  });

  test('an already verified row keeps the password its owner set', () => {
    const patch = linkedAccountPatch(new Date('2026-01-01'));
    assert.ok(
      !('passwordHash' in patch),
      'adding a second way to sign in must not remove the first',
    );
  });

  test('the patch never carries a password other than null', () => {
    // Belt and braces: this object is spread straight into an UPDATE, so a non-null
    // passwordHash appearing here would silently overwrite a real credential.
    for (const prior of [null, undefined, new Date()]) {
      const patch = linkedAccountPatch(prior);
      if ('passwordHash' in patch) assert.equal(patch.passwordHash, null);
    }
  });
});

/* ------------------------------- sessions after a password reset ---- */

suite('session validity after a reset', () => {
  const RESET_AT = new Date('2026-03-01T12:00:00.000Z');

  test('an account that has never reset keeps every session', () => {
    // Null must mean "no reset has happened", not "invalidate everything" — otherwise
    // adding the column signs every existing user out on deploy.
    assert(sessionSurvivesReset(Date.now(), null), 'a stamped token');
    assert(sessionSurvivesReset(undefined, null), 'and one from before the stamp existed');
    assert(sessionSurvivesReset(0, undefined), 'and one with no time on it at all');
  });

  test('a session minted before the reset is refused', () => {
    assert(
      !sessionSurvivesReset(RESET_AT.getTime() - 1, RESET_AT),
      'one millisecond before is before',
    );
    assert(
      !sessionSurvivesReset(RESET_AT.getTime() - 14 * 24 * 3600 * 1000, RESET_AT),
      'a fortnight-old token is exactly what a reset is meant to kill',
    );
  });

  test('a session minted after the reset is kept', () => {
    assert(sessionSurvivesReset(RESET_AT.getTime(), RESET_AT), 'the same instant survives');
    assert(sessionSurvivesReset(RESET_AT.getTime() + 1, RESET_AT), 'and anything after it');
  });

  test('a token carrying no issue time cannot outlive a reset', () => {
    // Tokens minted before this shipped have no `authAt`. They predate the reset,
    // because everything does, so they must not be given the benefit of the doubt.
    for (const junk of [undefined, null, '1772000000000', NaN, {}, Infinity]) {
      assert(!sessionSurvivesReset(junk, RESET_AT), `should refuse ${String(junk)}`);
    }
  });
});

/* ------------------------- the first password on an OAuth-only account ---- */

/**
 * The gap: signing up with Google or GitHub writes no `passwordHash`, so email +
 * password sign-in on that same address can never succeed — `authorize()` has nothing to
 * compare against and returns the same null a wrong password returns. lib/auth/
 * initial-password.ts decides who may close that gap, and both of its failure directions
 * are silent in a running app.
 *
 * Refusing too much is the mild one: the user keeps signing in with their provider and
 * nothing looks broken. Allowing too much is a hole — an account that already has a
 * password being writable from a session, or an unverified row being handed the working
 * password that lib/auth/account-linking.ts exists to deny it.
 */
suite('the first password on a provider-only account', () => {
  const OAUTH_ONLY = {
    passwordHash: null,
    emailVerified: new Date('2026-01-01'),
    email: 'someone@example.com',
  };
  // Shaped like a real stored value so nothing can pass by looking malformed.
  const EXISTING_HASH = 'scrypt$32768$8$1$c2FsdA==$a2V5';

  test('an OAuth account with no password is offered the step', () => {
    assert(needsInitialPassword(OAUTH_ONLY), 'this is the whole reason the step exists');
  });

  test('an account that already has a password is not', () => {
    // If this were true, a provider session could replace a password whose holder never
    // typed the old one — a password change with no knowledge of the password. Changing
    // one goes through the reset flow, which requires the inbox.
    assert(
      !needsInitialPassword({ ...OAUTH_ONLY, passwordHash: EXISTING_HASH }),
      'an existing credential is never overwritten from a session',
    );
  });

  test('an unverified row is not, however it got there', () => {
    // The combination `linkedAccountPatch` refuses to create: a password that works on a
    // row nobody has proved they own. This step must not be the way it appears.
    assert(!needsInitialPassword({ ...OAUTH_ONLY, emailVerified: null }));
    assert(!needsInitialPassword({ ...OAUTH_ONLY, emailVerified: undefined }));
  });

  test('a missing row is not', () => {
    assert(!needsInitialPassword(null), 'a deleted account is not an opportunity');
    assert(!needsInitialPassword(undefined));
  });

  test('the row linking just stripped a password from is exactly who this serves', () => {
    // `linkedAccountPatch(null)` is the unverified row whose password was discarded when
    // a provider verified it. It ends up verified with no password — the state that
    // cannot sign in with email at all. That user is the point of this step: they are now
    // inside a session the provider authenticated, which is stronger proof of ownership
    // than the mailed link the reset flow would otherwise have demanded.
    const patch = linkedAccountPatch(null);
    assert(
      needsInitialPassword({ email: OAUTH_ONLY.email, ...patch }),
      'a provider-verified row with no password may set one',
    );
  });

  test('the same strength rules as sign-up and reset', () => {
    // A weaker bar here would be a hole in the fence rather than a convenience: a
    // password set on this path signs in through `authorize()` like any other.
    const weak = initialPasswordVerdict(OAUTH_ONLY, 'password123');
    assert(!weak.ok && weak.refusal === 'weak', 'the commonest password in every list');
    assert(weak.problems!.length > 0, 'and the reason is named, since the user chose it');

    assert(!initialPasswordVerdict(OAUTH_ONLY, 'short').ok, 'too short is still too short');
    assert(
      initialPasswordVerdict(OAUTH_ONLY, 'mist over the harbour wall').ok,
      'and a passphrase passes',
    );
  });

  test('the email rule is applied against this account, not a blank string', () => {
    // Passing the row's own address through is what makes "someone-2026-x" refusable.
    // Drop it and the check silently degrades to length-only for the one guess most
    // likely to be tried against this specific account.
    const r = initialPasswordVerdict(OAUTH_ONLY, 'someone-2026-x');
    assert(!r.ok && r.refusal === 'weak', 'contains the local part of the address');
  });

  test("the email rule sees the normalised address, not the provider's spelling", () => {
    // What these rows are is the point: nobody typed this address into our sign-up form,
    // so it was never normalised on the way in — it is whatever the provider profile
    // said, and `allowDangerousEmailAccountLinking` stored it as-is. `signUpAction` hands
    // `checkPassword` a normalised address and `resetPasswordAction` hands it the token
    // identifier, which was minted from one; this path was handing it the raw column, so
    // the same account got a weaker version of the same named rule depending only on
    // which door the password came through.
    const gmail = { ...OAUTH_ONLY, email: 'First.Last+jobs@gmail.com' };
    const guess = 'firstlast2026';

    // Proof the two spellings really do disagree, so this cannot pass by accident on a
    // password the rule would have caught either way.
    assert(checkPassword(guess, 'First.Last+jobs@gmail.com').ok, 'the raw address misses it');
    assert(!checkPassword(guess, normalizeEmail(gmail.email)).ok, 'the normalised one does not');

    const r = initialPasswordVerdict(gmail, guess);
    assert(!r.ok && r.refusal === 'weak', 'the account name with a year on it is refused');
  });

  test('and a plus tag does not hide it at any provider', () => {
    // Gmail's dots are provider-specific; a plus tag is a convention everywhere, and
    // `normalizeEmail` strips it for every domain. An address the user gave the provider
    // as a tagged alias must not turn its own local part into an acceptable password.
    const tagged = { ...OAUTH_ONLY, email: 'annalovelace+jobs@example.org' };
    assert(!initialPasswordVerdict(tagged, 'annalovelace77').ok, 'tag stripped before the check');
  });

  test('normalising tightens one rule and loosens nothing', () => {
    // The change is narrow on purpose: it feeds one argument to `checkPassword` and can
    // only make the "contains your address" rule reach further. Length, the common list
    // and the repetition rules never looked at the address at all, and a passphrase with
    // nothing to do with the account must still pass on every spelling of it.
    for (const email of ['First.Last+jobs@gmail.com', 'firstlast@gmail.com', '', null]) {
      const state = { ...OAUTH_ONLY, email };
      assert(initialPasswordVerdict(state, 'mist over the harbour wall').ok, `passes for ${email}`);
      assert(!initialPasswordVerdict(state, 'password123').ok, 'and the common list still bites');
      assert(!initialPasswordVerdict(state, 'short').ok, 'and so does the length rule');
    }
  });

  test('a strong password is still refused when the row may not have one', () => {
    // The verdict is re-run server-side against a freshly read row, so these are the
    // states a second tab or a stale form can present. Strength must not be able to talk
    // its way past them.
    const strong = 'mist over the harbour wall';

    const taken = initialPasswordVerdict({ ...OAUTH_ONLY, passwordHash: EXISTING_HASH }, strong);
    assert(!taken.ok && taken.refusal === 'already-set', 'never a password change');

    const unverified = initialPasswordVerdict({ ...OAUTH_ONLY, emailVerified: null }, strong);
    assert(!unverified.ok && unverified.refusal === 'unverified', 'verification is not skippable');

    assert.equal(initialPasswordVerdict(null, strong).refusal, 'already-set', 'no row, no write');
  });

  test('every refusal carries a sentence the user can act on', () => {
    // This action runs inside a session, so unlike the pre-sign-in endpoints it is not
    // hiding whether an account exists — a blank refusal here would just strand someone
    // in their own account with no idea what to do next.
    const cases = [
      { state: OAUTH_ONLY, password: 'password123' },
      { state: { ...OAUTH_ONLY, passwordHash: EXISTING_HASH }, password: 'mist over the harbour wall' },
      { state: { ...OAUTH_ONLY, emailVerified: null }, password: 'mist over the harbour wall' },
    ];
    for (const { state, password } of cases) {
      const r = initialPasswordVerdict(state, password);
      assert(!r.ok, 'refused');
      assert(typeof r.message === 'string' && r.message.length > 20, `explained: ${r.message}`);
    }
  });
});
