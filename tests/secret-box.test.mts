/**
 * Encryption of the provider tokens stored in the `account` table.
 *
 * The GitHub token carries `repo` scope, because GitHub has no read-only variant that
 * reaches private repositories — so a leaked row is read and write access to everything
 * the user owns. What is pinned here is the property whose failure is silent: a value
 * that looks encrypted, is stored, and is actually recoverable by anyone holding the
 * database. And the migration property, which is just as silent in the other direction:
 * a plaintext row written before this existed must keep working.
 */

import {
  decryptSecret,
  encryptSecret,
  looksEncrypted,
  decryptIfPossible,
  encryptIfPossible,
  isEncryptionConfigured,
  secretsMatch,
} from '../lib/auth/secret-box';
import { suite, test, assert } from './harness.mjs';

const KEY = 'a'.repeat(48);
const OTHER_KEY = 'b'.repeat(48);

function withKey<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.TOKEN_ENC_KEY;
  if (value === undefined) delete process.env.TOKEN_ENC_KEY;
  else process.env.TOKEN_ENC_KEY = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TOKEN_ENC_KEY;
    else process.env.TOKEN_ENC_KEY = saved;
  }
}

/** Shaped like a real GitHub token, so nothing here passes on an unrealistic input. */
const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';

suite('secret encryption', () => {
  test('a token round-trips', () => {
    withKey(KEY, () => {
      const sealed = encryptSecret(TOKEN);
      assert(decryptSecret(sealed) === TOKEN, 'what goes in comes back out');
    });
  });

  test('the ciphertext does not contain the token', () => {
    withKey(KEY, () => {
      const sealed = encryptSecret(TOKEN);
      assert(!sealed.includes(TOKEN), 'not stored verbatim');
      assert(!sealed.includes('gho_'), 'and not even the recognisable prefix');
    });
  });

  test('the same token encrypts differently every time', () => {
    withKey(KEY, () => {
      const a = encryptSecret(TOKEN);
      const b = encryptSecret(TOKEN);
      assert(a !== b, 'a random IV per value, so two users cannot be seen to share a token');
      assert(decryptSecret(a) === decryptSecret(b), 'and both still decrypt');
    });
  });

  test('the wrong key cannot read it', () => {
    const sealed = withKey(KEY, () => encryptSecret(TOKEN));
    withKey(OTHER_KEY, () => {
      let threw = false;
      try {
        decryptSecret(sealed);
      } catch {
        threw = true;
      }
      assert(threw, 'a different key fails rather than returning garbage');
    });
  });

  test('a tampered ciphertext is refused, not silently altered', () => {
    withKey(KEY, () => {
      const sealed = encryptSecret(TOKEN);
      const parts = sealed.split('.');
      // Flip a character in the ciphertext. GCM authenticates, so this must fail.
      const data = parts[3];
      parts[3] = (data[0] === 'A' ? 'B' : 'A') + data.slice(1);

      let threw = false;
      try {
        decryptSecret(parts.join('.'));
      } catch {
        threw = true;
      }
      assert(threw, 'an altered row does not decrypt to different bytes');
    });
  });

  test('a truncated or malformed envelope is refused', () => {
    withKey(KEY, () => {
      for (const junk of ['v1.', 'v1.a.b', 'v1.a.b.c.d', 'v1.short.short.short']) {
        let threw = false;
        try {
          decryptSecret(junk);
        } catch {
          threw = true;
        }
        // Anything shaped like the envelope but wrong must throw; anything not shaped
        // like it is treated as plaintext, which the next suite covers.
        if (looksEncrypted(junk)) assert(threw, `refused: ${junk}`);
      }
    });
  });

  test('a key that is too short is refused outright', () => {
    withKey('tooshort', () => {
      assert(!isEncryptionConfigured(), 'a weak key is not a key');
      let threw = false;
      try {
        encryptSecret(TOKEN);
      } catch {
        threw = true;
      }
      assert(threw, 'and encrypting with it fails loudly');
    });
  });
});

suite('plaintext migration', () => {
  test('a stored plaintext token is recognised as such', () => {
    assert(!looksEncrypted(TOKEN), 'a real GitHub token is not mistaken for an envelope');
    assert(!looksEncrypted('ghp_abc.def.ghi'), 'nor is a dotted string without the version');
    assert(!looksEncrypted(''), 'nor is empty');
  });

  test('an encrypted value is recognised as such', () => {
    withKey(KEY, () => assert(looksEncrypted(encryptSecret(TOKEN)), 'its own output'));
  });

  test('a plaintext row keeps working — nobody is locked out by the upgrade', () => {
    withKey(KEY, () => {
      assert(
        decryptSecret(TOKEN) === TOKEN,
        'a row written before encryption existed still reads, so no sync breaks the day this ships',
      );
    });
  });

  test('with no key configured, values pass through unchanged', () => {
    withKey(undefined, () => {
      assert(!isEncryptionConfigured(), 'no key');
      assert(encryptIfPossible(TOKEN) === TOKEN, 'stored as-is rather than lost');
      assert(decryptIfPossible(TOKEN) === TOKEN, 'and read back');
    });
  });

  test('an unreadable value becomes null rather than throwing at the caller', () => {
    const sealed = withKey(KEY, () => encryptSecret(TOKEN));
    withKey(OTHER_KEY, () =>
      assert(
        decryptIfPossible(sealed) === null,
        'a rotated key means "no token", which every caller already handles',
      ),
    );
  });

  test('null and empty are handled without a key being needed', () => {
    withKey(undefined, () => {
      assert(encryptIfPossible(null) === null, 'null in, null out');
      assert(encryptIfPossible('') === null, 'empty is nothing to protect');
      assert(decryptIfPossible(undefined) === null, 'undefined in, null out');
    });
  });
});

suite('constant-time comparison', () => {
  test('equal secrets match, different ones do not', () => {
    assert(secretsMatch('abc123', 'abc123'), 'equal');
    assert(!secretsMatch('abc123', 'abc124'), 'one character apart');
    assert(!secretsMatch('abc', 'abcdef'), 'different lengths do not throw');
  });
});
