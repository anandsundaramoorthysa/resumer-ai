import { mayCreateOAuthUser, signInErrorMessage, SIGNUPS_PAUSED_MESSAGE } from '../lib/auth/signup-gate';
import { suite, test, assert } from './harness.mjs';

suite('OAuth sign-up kill switch', () => {
  test('creation follows the flag', () => {
    assert.equal(mayCreateOAuthUser(true), true);
    assert.equal(mayCreateOAuthUser(false), false);
  });
  test('a refused createUser reads as paused only while the flag is off', () => {
    assert.equal(signInErrorMessage('Configuration', false), SIGNUPS_PAUSED_MESSAGE);
    assert.equal(signInErrorMessage('AdapterError', false), SIGNUPS_PAUSED_MESSAGE);
    assert.notEqual(signInErrorMessage('Configuration', true), SIGNUPS_PAUSED_MESSAGE);
    assert.equal(signInErrorMessage(undefined, false), null);
  });
});
