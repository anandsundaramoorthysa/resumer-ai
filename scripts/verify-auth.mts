/**
 * The database-backed halves of authentication, against a real database.
 *
 * The server actions cannot be called from here — they read request headers — so what is
 * exercised is everything underneath them: token issue and single-use consumption, the
 * rate limiter's thresholds, and a full password lifecycle on a throwaway user row.
 *
 * The properties being checked are the ones whose failure is silent. A reset link that
 * can be spent twice still works the first time. A rate limiter that counts the wrong
 * subject still returns "allowed" and looks fine. Both need a real database to show.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { issueToken, consumeToken, hashToken } from '../lib/auth/tokens';
import { rateLimit, clearAttempts } from '../lib/auth/rate-limit';
import { hashPassword, verifyPassword } from '../lib/auth/password';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const EMAIL = `zzauthcheck-${Date.now()}@example.invalid`;
const IP = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;

/* ------------------------------------------------------------- tokens ---- */

const first = await issueToken(EMAIL, 'verify-email');
const [stored] = await sql<{ token_hash: string; purpose: string }[]>`
  select token_hash, purpose from auth_token where identifier = ${EMAIL} and used_at is null`;
check(stored?.token_hash === hashToken(first.token), 'only the hash of the link is stored');
check(stored?.token_hash !== first.token, 'the plaintext link is nowhere in the database');

const spent = await consumeToken(first.token, 'verify-email');
check(spent.ok && spent.identifier === EMAIL, 'a fresh link is spent and names its owner');

const again = await consumeToken(first.token, 'verify-email');
check(!again.ok, 'the same link cannot be spent twice — a mail client prefetch would otherwise burn it');

const wrongPurpose = await issueToken(EMAIL, 'reset-password');
const crossed = await consumeToken(wrongPurpose.token, 'verify-email');
check(!crossed.ok, 'a reset link cannot be used to verify an email');
check(
  (await consumeToken(wrongPurpose.token, 'reset-password')).ok,
  'and still works for what it was issued for',
);

const superseded = await issueToken(EMAIL, 'reset-password');
await issueToken(EMAIL, 'reset-password');
check(
  !(await consumeToken(superseded.token, 'reset-password')).ok,
  'requesting a second reset invalidates the first, so only the newest link works',
);

check(!(await consumeToken('', 'verify-email')).ok, 'an empty token is refused');
check(!(await consumeToken('x'.repeat(43), 'verify-email')).ok, 'a guessed token is refused');

// An expired link must fail even though it was never used.
const expiring = await issueToken(EMAIL, 'verify-email');
await sql`update auth_token set expires = now() - interval '1 minute'
          where token_hash = ${hashToken(expiring.token)}`;
check(!(await consumeToken(expiring.token, 'verify-email')).ok, 'an expired link is refused');

/* --------------------------------------------------------- rate limits ---- */

let allowedCount = 0;
for (let i = 0; i < 12; i++) {
  const verdict = await rateLimit('sign-in', EMAIL, IP);
  if (verdict.allowed) allowedCount++;
}
check(allowedCount === 8, `sign-in stops at its limit, allowed ${allowedCount} of 12`);

const other = await rateLimit('sign-in', `other-${EMAIL}`, null);
check(other.allowed, 'one address hitting its limit does not lock out another');

const otherAction = await rateLimit('reset-request', EMAIL, null);
check(otherAction.allowed, 'and the limits are per action, not shared');

await clearAttempts('sign-in', EMAIL);
check((await rateLimit('sign-in', EMAIL, null)).allowed, 'a successful sign-in clears the counter');

/* ------------------------------------------------- password lifecycle ---- */

// The id is generated in the application, not by the column: the schema uses Drizzle's
// $defaultFn, so a raw insert has to supply one.
const [created] = await sql<{ id: string }[]>`
  insert into "user" (id, email, name, password_hash)
  values (${randomUUID()}, ${EMAIL}, 'ZZ Auth Check', ${await hashPassword('first password phrase')})
  returning id`;

const [row] = await sql<{ password_hash: string; emailVerified: Date | null }[]>`
  select password_hash, "emailVerified" from "user" where id = ${created.id}`;
check(await verifyPassword('first password phrase', row.password_hash), 'the stored hash verifies');
check(!(await verifyPassword('second password phrase', row.password_hash)), 'and rejects another password');
check(row.emailVerified === null, 'a new password account starts unverified, so it cannot sign in yet');

// Verification, as verifyEmailAction performs it.
const verifyToken = await issueToken(EMAIL, 'verify-email');
const verified = await consumeToken(verifyToken.token, 'verify-email');
await sql`update "user" set "emailVerified" = now() where email = ${verified.identifier!}`;
const [afterVerify] = await sql<{ emailVerified: Date | null }[]>`
  select "emailVerified" from "user" where id = ${created.id}`;
check(afterVerify.emailVerified !== null, 'confirming the link verifies the account');

// Reset, as resetPasswordAction performs it.
const resetToken = await issueToken(EMAIL, 'reset-password');
const reset = await consumeToken(resetToken.token, 'reset-password');
await sql`update "user" set password_hash = ${await hashPassword('second password phrase')}
          where email = ${reset.identifier!}`;
const [afterReset] = await sql<{ password_hash: string }[]>`
  select password_hash from "user" where id = ${created.id}`;
check(await verifyPassword('second password phrase', afterReset.password_hash), 'the new password works');
check(
  !(await verifyPassword('first password phrase', afterReset.password_hash)),
  'and the old one no longer does',
);

/* -------------------------------------------------------------- cleanup ---- */

await sql`delete from "user" where id = ${created.id}`;
await sql`delete from auth_token where identifier in (${EMAIL}, ${'other-' + EMAIL})`;
await sql`delete from auth_attempt where subject in (${'email:' + EMAIL}, ${'ip:' + IP}, ${'email:other-' + EMAIL})`;

const [{ n: leftover }] = await sql<{ n: number }[]>`
  select count(*)::int as n from "user" where email like 'zzauthcheck-%'`;
check(leftover === 0, `no test accounts left behind (${leftover} found)`);

await sql.end();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
