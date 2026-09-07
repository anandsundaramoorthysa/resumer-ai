/**
 * Which provider sends the mail, and how its settings are read.
 *
 * The failure being guarded against is not a crash. It is a deployment where mail looks
 * configured, sign-up is offered, accounts are created, and no link is ever delivered —
 * so what is pinned here is the provider choice and the defaults that make a Gmail app
 * password work with two environment variables instead of five.
 */

import { describeSmtpError, smtpConfig } from '../lib/auth/smtp';
import { mailProvider, isMailConfigured, appUrl } from '../lib/auth/mail';
import { suite, test, assert } from './harness.mjs';

const KEYS = [
  'SMTP_USER', 'SMTP_PASS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE',
  'RESEND_API_KEY', 'EMAIL_FROM', 'AUTH_URL', 'NEXTAUTH_URL',
] as const;

/** Runs `fn` with exactly the given environment, restoring whatever was there before. */
function withEnv(env: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const k of KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  try {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

suite('smtp configuration', () => {
  test('a user and password alone are enough — Gmail fills in the rest', () => {
    withEnv({ SMTP_USER: 'me@gmail.com', SMTP_PASS: 'abcdefghijklmnop' }, () => {
      const c = smtpConfig()!;
      assert(c.host === 'smtp.gmail.com', `host defaulted, got ${c.host}`);
      assert(c.port === 465, `port defaulted, got ${c.port}`);
      assert(c.secure === true, '465 is implicit TLS');
      assert(c.from === 'me@gmail.com', 'from defaults to the authenticated account');
    });
  });

  test('the spaces Google shows in an app password are stripped', () => {
    withEnv({ SMTP_USER: 'me@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop' }, () => {
      assert(
        smtpConfig()!.pass === 'abcdefghijklmnop',
        'pasted with the display spaces, it still authenticates',
      );
    });
  });

  test('port 587 turns implicit TLS off, because it uses STARTTLS instead', () => {
    withEnv({ SMTP_USER: 'me@gmail.com', SMTP_PASS: 'x'.repeat(16), SMTP_PORT: '587' }, () => {
      const c = smtpConfig()!;
      assert(c.port === 587, 'port honoured');
      assert(c.secure === false, 'and secure follows from it without being set');
    });
  });

  test('an explicit SMTP_SECURE overrides the port-derived default', () => {
    withEnv(
      { SMTP_USER: 'me@example.com', SMTP_PASS: 'x'.repeat(16), SMTP_PORT: '2525', SMTP_SECURE: 'true' },
      () => assert(smtpConfig()!.secure === true, 'a non-standard port can still be told'),
    );
  });

  test('a different provider can override everything', () => {
    withEnv(
      {
        SMTP_USER: 'apikey', SMTP_PASS: 'secret', SMTP_HOST: 'smtp.postmarkapp.com',
        SMTP_PORT: '587', EMAIL_FROM: 'Resumer AI <hello@example.com>',
      },
      () => {
        const c = smtpConfig()!;
        assert(c.host === 'smtp.postmarkapp.com', 'host');
        assert(c.from === 'Resumer AI <hello@example.com>', 'and a real From address');
      },
    );
  });

  test('half a configuration is no configuration', () => {
    withEnv({ SMTP_USER: 'me@gmail.com' }, () => assert(smtpConfig() === null, 'user without password'));
    withEnv({ SMTP_PASS: 'abcdefghijklmnop' }, () => assert(smtpConfig() === null, 'password without user'));
    withEnv({ SMTP_USER: '  ', SMTP_PASS: '   ' }, () => assert(smtpConfig() === null, 'whitespace is empty'));
  });
});

suite('provider selection', () => {
  test('nothing configured is reported as nothing configured', () => {
    withEnv({}, () => {
      assert(mailProvider() === 'none', 'no provider');
      assert(!isMailConfigured(), 'and the sign-in page hides the email option');
    });
  });

  test('smtp alone is used', () => {
    withEnv({ SMTP_USER: 'me@gmail.com', SMTP_PASS: 'x'.repeat(16) }, () => {
      assert(mailProvider() === 'smtp', 'smtp');
      assert(isMailConfigured(), 'and email sign-up is available');
    });
  });

  test('resend alone is used, but only with a from address', () => {
    withEnv({ RESEND_API_KEY: 're_123' }, () =>
      assert(mailProvider() === 'none', 'an API key with nothing to send as cannot send'),
    );
    withEnv({ RESEND_API_KEY: 're_123', EMAIL_FROM: 'a@b.com' }, () =>
      assert(mailProvider() === 'resend', 'both present'),
    );
  });

  test('a verified sending domain beats Gmail when both are configured', () => {
    withEnv(
      {
        RESEND_API_KEY: 're_123', EMAIL_FROM: 'hello@example.com',
        SMTP_USER: 'me@gmail.com', SMTP_PASS: 'x'.repeat(16),
      },
      () =>
        assert(
          mailProvider() === 'resend',
          'SPF, DKIM and a warmed reputation beat a personal account with a 500-a-day cap',
        ),
    );
  });
});

suite('link building', () => {
  test('links are built from AUTH_URL', () => {
    withEnv({ AUTH_URL: 'https://resumeraiapp.netlify.app' }, () =>
      assert(
        appUrl('/verify-email?token=abc') === 'https://resumeraiapp.netlify.app/verify-email?token=abc',
        'the deployed host',
      ),
    );
  });

  test('a trailing slash does not produce a doubled one', () => {
    withEnv({ AUTH_URL: 'https://example.com/' }, () =>
      assert(appUrl('/verify-email') === 'https://example.com/verify-email', 'single slash'),
    );
  });

  test('with nothing set the links point at localhost, which is a development answer', () => {
    withEnv({}, () =>
      assert(appUrl('/x') === 'http://localhost:3000/x', 'and is why AUTH_URL must be set when deployed'),
    );
  });
});

suite('smtp error messages', () => {
  test('a rejected login says the thing Gmail does not say', () => {
    const message = describeSmtpError(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'));
    assert(message.includes('app password'), `names the actual fix: ${message}`);
    assert(message.includes('2-Step'), 'and the prerequisite for getting one');
  });

  test('a timeout points at the port and TLS mismatch that usually causes it', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const message = describeSmtpError(err);
    assert(message.includes('465') && message.includes('587'), `names both ports: ${message}`);
  });

  test('the daily cap is named as the cap rather than as a failure', () => {
    const message = describeSmtpError(new Error('Daily user sending quota exceeded'));
    assert(message.includes('500'), `says what the limit is: ${message}`);
  });

  test('anything else is passed through, truncated', () => {
    const message = describeSmtpError(new Error('x'.repeat(500)));
    assert(message.length <= 200, `bounded, got ${message.length}`);
  });

  test('a non-Error is handled', () => {
    assert(describeSmtpError('just a string').length > 0, 'no crash on an unexpected throw');
  });
});
