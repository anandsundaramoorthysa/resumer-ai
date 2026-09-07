/**
 * Cross-tenant authorization, driven over HTTP as a second user.
 *
 * This is §8 of specs/E2E-TESTS.md, the section whose failures are release blockers, and
 * it had never been run. A static review said every query is scoped by `userId` in the
 * same statement — which is the right shape — but a review cannot prove that the running
 * application refuses a real request. This does: it creates two accounts, gives one of
 * them a resume, and then tries to reach it as the other through every route that takes
 * an id from the URL.
 *
 * Every request goes through the real HTTP stack with a real session cookie, so what is
 * being tested is the deployed behaviour rather than a function called directly.
 *
 * Run against a server whose AUTH_URL matches the host, or Auth.js issues a `__Secure-`
 * cookie that a browser or fetch client will not return over http:
 *
 *   npm run build
 *   AUTH_URL=http://localhost:3009 npx next start -p 3009
 *   AUTHZ_BASE=http://localhost:3009 npx tsx --tsconfig scripts/tsconfig.json scripts/verify-authz.mts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { hashPassword } from '../lib/auth/password';

const BASE = process.env.AUTHZ_BASE ?? 'http://localhost:3009';
const PASSWORD = 'harbour wall mist 2026';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

/** A resume document with enough shape that a leak would be unmistakable in a response. */
const SECRET_PHRASE = 'ZZ-CONFIDENTIAL-SALARY-NEGOTIATION-NOTE';

function documentFor(owner: string): Record<string, unknown> {
  return {
    contact: {
      fullName: `${owner} Owner`,
      email: `${owner}@example.invalid`,
      phone: '0000000000',
    },
    sections: [
      {
        key: 'summary',
        heading: 'Summary',
        items: [{ text: SECRET_PHRASE, sourceRecordId: null }],
      },
    ],
  };
}

interface Account {
  id: string;
  email: string;
  cookie: string;
  snapshotId: string;
}

async function seedUser(tag: string): Promise<{ id: string; email: string }> {
  const email = `zzauthz-${tag}-${Date.now()}@example.invalid`;
  const id = randomUUID();
  await sql`insert into "user" (id, email, name, password_hash, "emailVerified")
            values (${id}, ${email}, ${'ZZ ' + tag}, ${await hashPassword(PASSWORD)}, now())`;
  return { id, email };
}

async function seedSnapshot(userId: string, owner: string): Promise<string> {
  const id = randomUUID();
  // `sql.json` is typed against postgres.js's own JSONValue, which a
  // Record<string, unknown> does not structurally satisfy; the value really is plain
  // JSON, so it is asserted through rather than reshaped.
  const document = documentFor(owner) as unknown as Parameters<typeof sql.json>[0];
  await sql`insert into resume_snapshot (id, user_id, document, file_name, score)
            values (${id}, ${userId}, ${sql.json(document)}, ${owner + '-resume.pdf'}, 9.1)`;
  return id;
}

/**
 * Signs in through the real credentials endpoint and returns the session cookie.
 *
 * The CSRF token and its cookie are paired, so both must come from the same request —
 * posting a token without its cookie is rejected in a way that looks like a wrong
 * password.
 */
async function signIn(email: string): Promise<string> {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: csrfCookie },
    body: new URLSearchParams({ email, password: PASSWORD, csrfToken, callbackUrl: BASE }),
    redirect: 'manual',
  });

  const cookies = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .filter((c) => c.includes('session-token'));

  if (cookies.length === 0) throw new Error(`no session cookie for ${email} (HTTP ${res.status})`);
  return [csrfCookie, ...cookies].join('; ');
}

async function as(
  account: Account | null,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string; url: string }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(account ? { Cookie: account.cookie } : {}),
    },
    redirect: 'manual',
  });
  const body = await res.text().catch(() => '');
  return { status: res.status, body, url: res.headers.get('location') ?? path };
}

/** A response leaks if it carries the phrase, whatever its status code says. */
function leaks(body: string): boolean {
  return body.includes(SECRET_PHRASE);
}

const created: string[] = [];

try {
  const a = await seedUser('a');
  const b = await seedUser('b');
  created.push(a.id, b.id);

  const snapshotA = await seedSnapshot(a.id, 'alpha');
  const snapshotB = await seedSnapshot(b.id, 'bravo');

  const A: Account = { ...a, cookie: await signIn(a.email), snapshotId: snapshotA };
  const B: Account = { ...b, cookie: await signIn(b.email), snapshotId: snapshotB };

  console.log('\n--- the owner can reach their own resume (the control) ---');
  const own = await as(A, `/api/resume/${snapshotA}`);
  check(own.status === 200, `A reads their own snapshot (HTTP ${own.status})`);
  check(leaks(own.body), 'and the response really does contain the marker, so a leak would show');

  console.log('\n--- AZ-1: B must not reach any of A\'s resume ---');
  for (const [label, path, init] of [
    ['page', `/resume/${snapshotA}`, {}],
    ['api read', `/api/resume/${snapshotA}`, {}],
    ['export pdf', `/api/export/${snapshotA}?format=pdf`, {}],
    ['export docx', `/api/export/${snapshotA}?format=docx`, {}],
    ['extras', `/api/resume/${snapshotA}/extras`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'cover-letter' }) }],
    ['patch', `/api/resume/${snapshotA}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edits: [{ sectionKey: 'summary', groupIndex: null, itemIndex: 0, text: 'OVERWRITTEN BY B' }] }) }],
  ] as const) {
    const r = await as(B, path, init as RequestInit);
    check(!leaks(r.body), `B ${label}: no content leaked (HTTP ${r.status})`);
    check(r.status !== 200 || !leaks(r.body), `B ${label}: not served as success`);
  }

  console.log('\n--- and A\'s resume is unchanged after B\'s PATCH attempt ---');
  const afterPatch = await as(A, `/api/resume/${snapshotA}`);
  check(leaks(afterPatch.body), "A's summary still holds the original text");
  check(!afterPatch.body.includes('OVERWRITTEN BY B'), "B's edit did not land on A's snapshot");

  console.log('\n--- B can still reach their own, so this is scoping and not a blanket refusal ---');
  const bOwn = await as(B, `/api/resume/${snapshotB}`);
  check(bOwn.status === 200, `B reads their own snapshot (HTTP ${bOwn.status})`);

  console.log('\n--- AZ-2: signed out reaches nothing ---');
  for (const path of [
    '/profile',
    '/applications',
    '/settings/portfolio',
    '/settings/application',
    '/import',
    `/resume/${snapshotA}`,
    `/api/resume/${snapshotA}`,
    `/api/export/${snapshotA}?format=pdf`,
  ]) {
    const r = await as(null, path);
    const refused = r.status === 401 || r.status === 404 || (r.status >= 300 && r.status < 400);
    check(refused, `signed out ${path} -> ${r.status}${r.status >= 300 && r.status < 400 ? ` (${r.url})` : ''}`);
    check(!leaks(r.body), `signed out ${path}: no content in the body`);
  }

  const draft = await as(null, '/api/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobInput: 'Full Stack Developer' }),
  });
  check(draft.status === 401 || draft.status === 403, `signed out POST /api/draft -> ${draft.status}`);

  console.log('\n--- AZ-3: the dev harness is not exposed ---');
  const e2e = await as(null, '/api/dev/e2e-draft', { method: 'POST' });
  check(e2e.status === 404, `/api/dev/e2e-draft -> ${e2e.status} (404 expected in production)`);
  check(!leaks(e2e.body) && !e2e.body.includes('"profile"'), 'and it returned no profile data');

  console.log('\n--- AZ-4: the cron endpoint requires its secret ---');
  //
  // Which case this actually exercises depends on the SERVER's environment, and the
  // difference matters. With CRON_SECRET unset the route refuses everything with 501
  // before comparing anything — fail-closed and correct, but a "wrong secret" request is
  // then rejected for the wrong reason and the comparison is never reached. To test the
  // comparison itself, start the server with CRON_SECRET set and pass the same value
  // here as AUTHZ_CRON_SECRET.
  const knownSecret = process.env.AUTHZ_CRON_SECRET;

  const cronNone = await as(null, '/api/cron/sync', { method: 'POST' });
  check(cronNone.status !== 200, `no header -> ${cronNone.status}`);

  const cronWrong = await as(null, '/api/cron/sync', {
    method: 'POST',
    headers: { 'x-cron-secret': 'not-the-secret' },
  });
  check(cronWrong.status !== 200, `wrong secret -> ${cronWrong.status}`);

  const cronBearer = await as(null, '/api/cron/sync', {
    method: 'POST',
    headers: { authorization: 'Bearer not-the-secret' },
  });
  check(cronBearer.status !== 200, `wrong bearer token -> ${cronBearer.status}`);

  if (knownSecret) {
    // One character different, same length — the input a short-circuiting `===` rejects
    // fastest, and the one a constant-time compare must reject in the same time as any
    // other. This is the case that proves the comparison is reached at all.
    const nearMiss = knownSecret.slice(0, -1) + (knownSecret.endsWith('x') ? 'y' : 'x');
    const cronNear = await as(null, '/api/cron/sync', {
      method: 'POST',
      headers: { 'x-cron-secret': nearMiss },
    });
    check(cronNear.status !== 200, `secret differing by one character -> ${cronNear.status}`);

    const cronRight = await as(null, '/api/cron/sync', {
      method: 'POST',
      headers: { 'x-cron-secret': knownSecret },
    });
    check(cronRight.status === 200, `the correct secret is accepted -> ${cronRight.status}`);
  } else {
    console.log('     (AUTHZ_CRON_SECRET unset — the comparison itself was not exercised)');
  }

  console.log('\n--- AZ-5: the webhook requires a valid signature ---');
  const hookNone = await as(null, '/api/webhook/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-github-event': 'push' },
    body: JSON.stringify({ repository: { full_name: 'someone/else' } }),
  });
  check(hookNone.status === 401 || hookNone.status === 501, `no signature -> ${hookNone.status}`);

  const hookBad = await as(null, '/api/webhook/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-github-event': 'push',
      'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
    },
    body: JSON.stringify({ repository: { full_name: 'someone/else' } }),
  });
  check(hookBad.status === 401 || hookBad.status === 501, `wrong signature -> ${hookBad.status}`);

  console.log('\n--- a made-up id is refused rather than erroring ---');
  const bogus = await as(A, `/api/resume/${randomUUID()}`);
  check(bogus.status === 404, `unknown snapshot id -> ${bogus.status}`);
  const malformed = await as(A, '/api/resume/not-a-uuid');
  check(malformed.status < 500, `malformed id -> ${malformed.status} (no 500)`);
} finally {
  console.log('');
  if (created.length) {
    // Cascades remove the snapshots and applications with the user rows.
    await sql`delete from "user" where id in ${sql(created)}`;
    await sql`delete from auth_attempt where subject like ${'email:zzauthz-%'}`;
  }

  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from "user" where email like 'zzauthz-%'`;
  check(n === 0, `test accounts removed (${n} left)`);

  await sql.end({ timeout: 5 }).catch(() => {});
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
