/** Pre-account-hijack defence, owner-session helper, and deleted-account session rule. */

import {
  signupBindingMatches,
  signupBindingValue,
} from '../lib/auth/signup-binding';
import { sessionIsLive } from '../lib/auth/session-validity';
import { suite, test, assert } from './harness.mjs';

suite('signup binding', () => {
  const secret = 'a-test-secret-of-reasonable-length';
  const cookie = signupBindingValue(secret, 'Victim@Example.com', 'hash-1');

  test('the signing-up browser verifies', () => {
    assert(signupBindingMatches(cookie, secret, 'victim@example.com', 'hash-1'), 'matches');
  });
  test('a browser with no cookie does not match', () => {
    assert(!signupBindingMatches(undefined, secret, 'victim@example.com', 'hash-1'), 'no cookie');
    assert(!signupBindingMatches('', secret, 'victim@example.com', 'hash-1'), 'empty cookie');
  });
  test('a changed password invalidates the old binding', () => {
    assert(!signupBindingMatches(cookie, secret, 'victim@example.com', 'hash-2'), 'new hash');
  });
  test('another address or secret does not match', () => {
    assert(!signupBindingMatches(cookie, secret, 'other@example.com', 'hash-1'), 'other email');
    assert(!signupBindingMatches(cookie, 'different-secret-value-here-xx', 'victim@example.com', 'hash-1'), 'other secret');
  });
  test('no secret or no password hash fails closed', () => {
    assert(!signupBindingMatches(cookie, undefined, 'victim@example.com', 'hash-1'), 'no secret');
    assert(!signupBindingMatches(cookie, secret, 'victim@example.com', null), 'no hash');
  });
});

suite('session liveness', () => {
  test('a deleted account (no row) is a dead session', () => {
    assert(!sessionIsLive(Date.now(), undefined), 'undefined row');
    assert(!sessionIsLive(Date.now(), null), 'null row');
  });
  test('an existing account with no reset is live', () => {
    assert(sessionIsLive(Date.now(), { sessionsValidFrom: null }), 'live');
  });
  test('a token older than the reset is dead', () => {
    assert(!sessionIsLive(1000, { sessionsValidFrom: new Date(2000) }), 'predates reset');
    assert(sessionIsLive(3000, { sessionsValidFrom: new Date(2000) }), 'after reset');
  });
});
