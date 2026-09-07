/**
 * Checks that email actually sends, before anyone depends on it.
 *
 * Mail is the one part of sign-up that fails silently at exactly the wrong moment: the
 * account is created, the link never arrives, and the person is stuck with no way to
 * confirm and no idea why. So this connects and authenticates for real, and can send a
 * genuine message to an address you name.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/verify-mail.mts
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/verify-mail.mts you@example.com
 *
 * With an address it sends a real verification-shaped email, so you can confirm the whole
 * path including what it looks like in an inbox and whether it lands in spam.
 */
import 'dotenv/config';
import { describeMailProvider, mailProvider, sendVerificationEmail, appUrl } from '../lib/auth/mail';
import { smtpConfig, verifySmtp } from '../lib/auth/smtp';

const recipient = process.argv[2];
const provider = mailProvider();

console.log(`provider:  ${provider}`);
console.log(`details:   ${describeMailProvider()}`);
console.log(`links use: ${appUrl('/verify-email?token=…')}`);
console.log('');

if (provider === 'none') {
  console.log('Nothing is configured, so email sign-up is hidden in production and links');
  console.log('are written to the server log in development.');
  console.log('');
  console.log('For Gmail, set:');
  console.log('  SMTP_USER=you@gmail.com');
  console.log('  SMTP_PASS=<16-character app password from myaccount.google.com/apppasswords>');
  process.exit(1);
}

if (provider === 'smtp') {
  const config = smtpConfig()!;
  console.log(`connecting to ${config.host}:${config.port} (secure: ${config.secure}) as ${config.user}…`);
  const verified = await verifySmtp(config);
  if (!verified.ok) {
    console.error(`FAIL  ${verified.error}`);
    process.exit(1);
  }
  console.log('ok    the server accepted the credentials');
}

if (!recipient) {
  console.log('');
  console.log('Pass an address to send a real test message:');
  console.log('  npx tsx --tsconfig scripts/tsconfig.json scripts/verify-mail.mts you@example.com');
  process.exit(0);
}

console.log(`\nsending a test verification email to ${recipient}…`);
const sent = await sendVerificationEmail(recipient, 'test-token-not-a-real-link');

if (!sent.ok) {
  console.error(`FAIL  ${sent.error}`);
  process.exit(1);
}
if (sent.loggedOnly) {
  console.log('ok    written to the log only — no provider is configured');
  process.exit(0);
}

console.log('ok    sent. Check the inbox, and the spam folder.');
console.log('');
console.log('The link in it will not work — the token is a placeholder, not an issued one.');
