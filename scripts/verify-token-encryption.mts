/**
 * Token encryption, against the real stored GitHub token.
 *
 * The unit tests prove the crypto. What they cannot prove is the thing that actually
 * matters on the day this ships: that the token already in the database still works, is
 * upgraded in place on first read, and that the upgraded value is genuinely unreadable
 * to anyone holding only the database.
 *
 * The token itself is never printed — only its prefix, its length, and whether GitHub
 * accepted it.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { getGithubToken, countPlaintextTokens } from '../lib/server/github-token';
import { looksEncrypted, isEncryptionConfigured } from '../lib/auth/secret-box';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

check(isEncryptionConfigured(), 'TOKEN_ENC_KEY is configured');

const [user] = await sql<{ id: string }[]>`select id from "user" limit 1`;
if (!user) throw new Error('no user in the database');

const before = await sql<{ access_token: string | null }[]>`
  select access_token from account where "userId" = ${user.id} and provider = 'github'`;
const storedBefore = before[0]?.access_token ?? null;
console.log(
  `    stored before: ${storedBefore ? (looksEncrypted(storedBefore) ? 'encrypted' : 'PLAINTEXT') : 'none'}` +
    `${storedBefore ? ` (${storedBefore.length} chars)` : ''}`,
);

// --- the read path -----------------------------------------------------------------
const token = await getGithubToken(user.id);
check(token !== null, 'the token reads back through the accessor');
check(
  token !== null && /^gh[oprsu]_/.test(token),
  `and it is shaped like a GitHub token (${token ? token.slice(0, 4) : 'null'}…, ${token?.length ?? 0} chars)`,
);

// --- the upgrade -------------------------------------------------------------------
const after = await sql<{ access_token: string | null }[]>`
  select access_token from account where "userId" = ${user.id} and provider = 'github'`;
const storedAfter = after[0]?.access_token ?? null;

check(storedAfter !== null && looksEncrypted(storedAfter), 'the stored value is now encrypted');
check(
  storedAfter !== null && token !== null && !storedAfter.includes(token),
  'and the ciphertext does not contain the token',
);
check(
  storedAfter !== null && !/^gh[oprsu]_/.test(storedAfter),
  'nor does it even begin like one',
);

// --- reading it again must be stable ------------------------------------------------
const second = await getGithubToken(user.id);
check(second === token, 'a second read returns the same token');

const stillPlaintext = await countPlaintextTokens();
check(stillPlaintext === 0, `no provider token is left in the clear (${stillPlaintext} found)`);

// --- and GitHub still accepts it ----------------------------------------------------
if (token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'ResumerAI/1.0' },
  });
  check(res.ok, `GitHub accepts the decrypted token (HTTP ${res.status})`);
  if (res.ok) {
    const me = (await res.json()) as { login?: string };
    console.log(`    authenticated as ${me.login}`);
  }

  const scopes = res.headers.get('x-oauth-scopes');
  console.log(`    scopes on this token: ${scopes || '(none reported)'}`);
}

// --- the refresh path, forced -------------------------------------------------------
//
// GitHub can be configured to expire user-to-server tokens after eight hours. Nothing in
// this codebase acted on that, so the live token had been dead for fourteen hours and
// portfolio sync had been failing silently. Expiry is pushed into the past here to prove
// the refresh actually happens, rather than waiting eight hours to find out.
const [row] = await sql<{ expires_at: number | null; access_token: string }[]>`
  select expires_at, access_token from account where "userId" = ${user.id} and provider = 'github'`;

if (row?.expires_at) {
  const cipherBefore = row.access_token;
  await sql`update account set expires_at = ${Math.floor(Date.now() / 1000) - 3600}
            where "userId" = ${user.id} and provider = 'github'`;

  const refreshed = await getGithubToken(user.id);
  check(refreshed !== null, 'an expired token is refreshed rather than returned dead');

  const [now] = await sql<{ expires_at: number | null; access_token: string }[]>`
    select expires_at, access_token from account where "userId" = ${user.id} and provider = 'github'`;

  check(
    (now?.expires_at ?? 0) > Math.floor(Date.now() / 1000),
    `the new expiry is in the future (${now?.expires_at ? new Date(now.expires_at * 1000).toISOString() : 'none'})`,
  );
  check(now?.access_token !== cipherBefore, 'and a genuinely new token was stored');
  check(looksEncrypted(now?.access_token ?? ''), 'stored encrypted, like the first one');

  if (refreshed) {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${refreshed}`, 'User-Agent': 'ResumerAI/1.0' },
    });
    check(res.ok, `GitHub accepts the refreshed token (HTTP ${res.status})`);
  }
} else {
  console.log('    (no expiry recorded on this token — the refresh path is not exercised)');
}

await sql.end();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
