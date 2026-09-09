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
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '../lib/db';
import { users } from '../lib/db/schema';
import { issueToken, consumeToken, hashToken } from '../lib/auth/tokens';
import { rateLimit, clearAttempts } from '../lib/auth/rate-limit';
import { hashPassword, verifyPassword } from '../lib/auth/password';
import { sessionSurvivesReset } from '../lib/auth/session-validity';

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

/* ----------------------------------- sessions after a password reset ---- */

/**
 * Changing the password used not to end anybody's session.
 *
 * Sessions are stateless JWTs, so there is no row to delete: the token in whoever's
 * cookie jar kept working for its full lifetime, and the user who reset *because* they
 * believed they were compromised was not actually safe afterwards. Nothing about that
 * was visible — the reset succeeded, the new password worked, the old session also kept
 * working.
 *
 * What is reproduced here is the sequence against the real column: a session that
 * existed before the reset, the reset itself as `resetPasswordAction` performs it, and
 * the decision `auth.ts` makes on the next request.
 *
 * The write and the reads go through Drizzle rather than the raw `sql` used elsewhere
 * in this file, because that is the round trip auth.ts actually performs and the column
 * is `timestamp` WITHOUT time zone. Drizzle writes and re-reads it as UTC; a raw
 * postgres.js read of the same column returns it as local time, which on this machine
 * is five and a half hours in the past — and a cut-off in the past invalidates nothing
 * while looking exactly like a working check. That is the silent failure this whole
 * section exists to catch, so it is asserted directly below.
 */
const SESSION_EMAIL = EMAIL.replace('zzauthcheck-', 'zzauthcheck-sessions-');
const [sessionUser] = await sql<{ id: string; sessions_valid_from: Date | null }[]>`
  insert into "user" (id, email, name, password_hash, "emailVerified")
  values (${randomUUID()}, ${SESSION_EMAIL}, 'ZZ Sessions',
          ${await hashPassword('a phrase before the reset')}, now())
  returning id, sessions_valid_from`;

check(
  sessionUser.sessions_valid_from === null,
  'a fresh account has no reset recorded, so no session is invalidated by the column existing',
);

/** What the `session` callback reads on every request. */
async function currentCutoff(): Promise<Date | null> {
  const [row] = await db
    .select({ sessionsValidFrom: users.sessionsValidFrom })
    .from(users)
    .where(eq(users.id, sessionUser.id))
    .limit(1);
  return row?.sessionsValidFrom ?? null;
}

// The token this user is already carrying, stamped when they signed in.
const existingSessionMintedAt = Date.now();

const beforeReset = await currentCutoff();
check(
  sessionSurvivesReset(existingSessionMintedAt, beforeReset),
  'and that session is accepted while no reset has happened',
);
check(
  sessionSurvivesReset(undefined, beforeReset),
  'as is one minted before this stamp existed at all — nobody is signed out on deploy',
);

// The reset, exactly as resetPasswordAction writes it.
await new Promise((r) => setTimeout(r, 5));
const resetAt = new Date();
await db
  .update(users)
  .set({
    passwordHash: await hashPassword('a phrase set by the reset'),
    emailVerified: resetAt,
    sessionsValidFrom: resetAt,
  })
  .where(eq(users.id, sessionUser.id));

const resetCutoff = await currentCutoff();

check(resetCutoff !== null, 'the reset records when it happened');
check(
  resetCutoff !== null && Math.abs(resetCutoff.getTime() - resetAt.getTime()) < 1000,
  `the stored cut-off reads back as the instant it was written (off by ${
    resetCutoff ? resetCutoff.getTime() - resetAt.getTime() : 'n/a'
  }ms)`,
);
check(
  !sessionSurvivesReset(existingSessionMintedAt, resetCutoff),
  'the session that existed before the reset is refused — this is the whole fix',
);
check(
  !sessionSurvivesReset(undefined, resetCutoff),
  'and so is an unstamped one, which cannot prove it is newer than the reset',
);
check(
  sessionSurvivesReset(Date.now(), resetCutoff),
  'while signing in again with the new password works immediately',
);

// A reset on one account must not sign anybody else out.
const [bystander] = await db
  .select({ sessionsValidFrom: users.sessionsValidFrom })
  .from(users)
  .where(eq(users.id, created.id))
  .limit(1);
check(
  bystander.sessionsValidFrom === null &&
    sessionSurvivesReset(existingSessionMintedAt, bystander.sessionsValidFrom),
  'another account, untouched, keeps its sessions',
);

/* ------------------------------------------- pre-hijack account takeover ---- */

/**
 * The attack this guards against.
 *
 * Sign-up writes a row for any address that has no row yet, holding the submitted
 * password with `emailVerified` null. On its own that is safe — `authorize()` refuses an
 * unverified row, so the password is inert. It stops being safe if that row can later be
 * verified by someone else: an attacker signs up as an address they do not own and never
 * opens the mail, the real owner later signs in with Google or GitHub, account linking
 * finds the row by email, and stamping it verified hands the attacker's password the
 * last gate it was missing.
 *
 * So the `signIn` callback discards a password on a row that was not already verified.
 * What is reproduced here is that exact sequence against the real column.
 */
const VICTIM = `zzauthcheck-victim-${Date.now()}@example.invalid`;

const [dormant] = await sql<{ id: string }[]>`
  insert into "user" (id, email, name, password_hash)
  values (${randomUUID()}, ${VICTIM}, 'ZZ Victim', ${await hashPassword("attacker's chosen phrase")})
  returning id`;

const [beforeLink] = await sql<{ password_hash: string | null; emailVerified: Date | null }[]>`
  select password_hash, "emailVerified" from "user" where id = ${dormant.id}`;
check(
  beforeLink.emailVerified === null && beforeLink.password_hash !== null,
  'an unclaimed address can be signed up for, and sits unverified with a password on it',
);

// What auth.ts does when an OAuth sign-in links to this row.
const [priorState] = await sql<{ emailVerified: Date | null }[]>`
  select "emailVerified" from "user" where id = ${dormant.id}`;
await sql`
  update "user"
  set "emailVerified" = now(),
      password_hash = ${priorState.emailVerified ? sql`password_hash` : null}
  where id = ${dormant.id}`;

const [afterLink] = await sql<{ password_hash: string | null; emailVerified: Date | null }[]>`
  select password_hash, "emailVerified" from "user" where id = ${dormant.id}`;
check(afterLink.emailVerified !== null, 'signing in with a provider verifies the address');
check(
  afterLink.password_hash === null,
  'and discards the password nobody proved they owned — otherwise it is account takeover',
);

// The other direction must be untouched: a verified account keeps its password when it
// later links a provider, or everyone who does that loses the ability to sign in.
const [ownedByUser] = await sql<{ id: string }[]>`
  insert into "user" (id, email, name, password_hash, "emailVerified")
  values (${randomUUID()}, ${'owner-' + VICTIM}, 'ZZ Owner',
          ${await hashPassword('a phrase its owner set')}, now())
  returning id`;
const [ownerPrior] = await sql<{ emailVerified: Date | null }[]>`
  select "emailVerified" from "user" where id = ${ownedByUser.id}`;
await sql`
  update "user"
  set "emailVerified" = now(),
      password_hash = ${ownerPrior.emailVerified ? sql`password_hash` : null}
  where id = ${ownedByUser.id}`;
const [ownerAfter] = await sql<{ password_hash: string | null }[]>`
  select password_hash from "user" where id = ${ownedByUser.id}`;
check(
  ownerAfter.password_hash !== null &&
    (await verifyPassword('a phrase its owner set', ownerAfter.password_hash)),
  'a verified account that adds a provider keeps the password it already proved',
);

/* -------------------------------------------------------------- cleanup ---- */

await sql`delete from "user"
          where id in (${created.id}, ${dormant.id}, ${ownedByUser.id}, ${sessionUser.id})`;
await sql`delete from auth_token where identifier in (${EMAIL}, ${'other-' + EMAIL})`;
await sql`delete from auth_attempt where subject in (${'email:' + EMAIL}, ${'ip:' + IP}, ${'email:other-' + EMAIL})`;

const [{ n: leftover }] = await sql<{ n: number }[]>`
  select count(*)::int as n from "user" where email like 'zzauthcheck-%'`;
check(leftover === 0, `no test accounts left behind (${leftover} found)`);

await sql.end();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
