/**
 * GitHub App authentication.
 *
 * The point of the App is that no long-lived repository credential is stored: access is
 * a JWT signed with a private key, exchanged for a one-hour installation token. What is
 * pinned here is the half that can be tested without a network — the JWT, which is the
 * thing GitHub verifies and therefore the thing that must be exactly right — plus the
 * configuration handling, where the failure mode is a multi-line PEM arriving from an
 * environment variable with its newlines escaped.
 */

import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import {
  appJwt,
  githubAppConfig,
  installationOwnedBy,
  isGitHubAppConfigured,
  installUrl,
} from '../lib/github/app';
import { suite, test, assert } from './harness.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_SLUG'] as const;

function withEnv<T>(env: Partial<Record<(typeof KEYS)[number], string>>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const k of KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  try {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

suite('github app configuration', () => {
  test('nothing configured is reported as nothing configured', () => {
    withEnv({}, () => {
      assert(githubAppConfig() === null, 'no config');
      assert(!isGitHubAppConfigured(), 'and the OAuth fallback stays in charge');
    });
  });

  test('an id without a key is not a configuration', () => {
    withEnv({ GITHUB_APP_ID: '12345' }, () =>
      assert(githubAppConfig() === null, 'half a configuration cannot sign anything'),
    );
  });

  test('a key pasted with escaped newlines is repaired', () => {
    // Most dashboards store single-line values, so a PEM arrives with literal \\n. Left
    // alone it fails inside OpenSSL with an error that names none of this.
    const escaped = privateKey.replace(/\n/g, '\\n');
    withEnv({ GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: escaped }, () => {
      const config = githubAppConfig();
      assert(config !== null, 'accepted');
      assert(config!.privateKey.includes('\n'), 'and the real newlines are back');
      assert(!config!.privateKey.includes('\\n'), 'with no literal escapes left');
    });
  });

  test('a real multi-line key is left alone', () => {
    withEnv({ GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: privateKey }, () =>
      assert(githubAppConfig()!.privateKey === privateKey.trim(), 'unchanged'),
    );
  });

  test('something that is not a PEM is refused', () => {
    withEnv({ GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: 'not-a-key' }, () =>
      assert(githubAppConfig() === null, 'refused before it reaches OpenSSL'),
    );
  });
});

suite('app jwt', () => {
  const env = { GITHUB_APP_ID: '987654', GITHUB_APP_PRIVATE_KEY: privateKey };

  test('it verifies against the public key', () => {
    withEnv(env, () => {
      const token = appJwt();
      const [header, payload, signature] = token.split('.');

      const verified = createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(createPublicKey(publicKey), Buffer.from(signature, 'base64url'));

      assert(verified, 'GitHub will accept this signature, or it will accept none');
    });
  });

  test('the header names RS256, which is the only algorithm GitHub takes', () => {
    withEnv(env, () => {
      const header = decodeSegment(appJwt().split('.')[0]);
      assert(header.alg === 'RS256', `got ${header.alg}`);
      assert(header.typ === 'JWT', 'and a JWT type');
    });
  });

  test('the issuer is the app id', () => {
    withEnv(env, () => {
      const payload = decodeSegment(appJwt().split('.')[1]);
      assert(payload.iss === '987654', `got ${payload.iss}`);
    });
  });

  test('issued-at is backdated, because a fast clock is rejected outright', () => {
    withEnv(env, () => {
      const payload = decodeSegment(appJwt().split('.')[1]);
      const now = Math.floor(Date.now() / 1000);
      assert((payload.iat as number) < now, 'iat is in the past');
      assert(now - (payload.iat as number) <= 90, 'but not absurdly so');
    });
  });

  test('expiry is inside the ten minutes GitHub allows', () => {
    withEnv(env, () => {
      const payload = decodeSegment(appJwt().split('.')[1]);
      const life = (payload.exp as number) - (payload.iat as number);
      assert(life > 0, 'it expires after it starts');
      assert(life <= 600, `no more than ten minutes, got ${life}s`);
    });
  });

  test('signing without a configuration throws rather than producing a bad token', () => {
    withEnv({}, () => {
      let threw = false;
      try {
        appJwt();
      } catch {
        threw = true;
      }
      assert(threw, 'an unsigned or wrongly-signed JWT is worse than an error');
    });
  });
});

suite('who an installation belongs to', () => {
  test('an installation on the GitHub user this person signed in as is theirs', () => {
    assert(installationOwnedBy({ accountId: 135801803, targetType: 'User' }, ['135801803']), 'accepted');
  });

  test("someone else's installation id is refused, however it was obtained", () => {
    // The attack: sign up, then call the install route with the owner's installation id.
    assert(!installationOwnedBy({ accountId: 135801803, targetType: 'User' }, ['999']), 'another GitHub user');
    assert(!installationOwnedBy({ accountId: 135801803, targetType: 'User' }, []), 'no GitHub sign-in at all');
  });

  test('an organisation is not a personal account, whatever its id happens to be', () => {
    // Memberships are checked separately, below; a matching *user* id proves nothing here.
    assert(!installationOwnedBy({ accountId: 42, targetType: 'Organization' }, ['42']), 'refused');
  });
});

suite('install link', () => {
  test('it points at the app by slug', () => {
    withEnv(
      { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_SLUG: 'resumer-ai' },
      () =>
        assert(
          installUrl() === 'https://github.com/apps/resumer-ai/installations/new',
          `got ${installUrl()}`,
        ),
    );
  });

  test('without a slug there is no link to offer', () => {
    withEnv({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey }, () =>
      assert(installUrl() === null, 'the panel says what is missing instead of linking nowhere'),
    );
  });
});

suite('an installation on an organisation', () => {
  const org = { accountId: 9001, targetType: 'Organization' };

  test('a member of that organisation may claim it', () => {
    assert(installationOwnedBy(org, ['135801803'], ['9001']), 'accepted');
  });

  test('someone who is not a member may not, however they found the id', () => {
    assert(!installationOwnedBy(org, ['135801803'], ['4242']), 'another org');
    assert(!installationOwnedBy(org, ['135801803'], []), 'membership unknown');
  });

  test('a personal installation is still judged on the account, not on memberships', () => {
    assert(!installationOwnedBy({ accountId: 9001, targetType: 'User' }, ['1'], ['9001']), 'not theirs');
    assert(installationOwnedBy({ accountId: 9001, targetType: 'User' }, ['9001'], []), 'theirs');
  });
});
