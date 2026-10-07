/**
 * The HTTP route handlers, called directly with `new Request(...)` against an in-memory
 * Postgres. Coverage of app/api was 0 of 23 routes: nothing pinned that the webhook rejects a
 * forged signature, that a cron route answers a wrong secret with 401, or that an export
 * will not hand one user's data to another.
 *
 * `@/auth` is the session stand-in (tests/db/auth-stub.mts). The network is disabled.
 */
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { setSession } from './db/auth-stub.mjs';
import { setTestDb } from './db/lib-db-stub.mjs';
import { mkRecord, mkUser, one } from './db/seed.mjs';
import { POST as webhook } from '../app/api/webhook/github/route';
import { GET as alerts } from '../app/api/cron/alerts/route';
import { GET as cronSync } from '../app/api/cron/sync/route';
import { GET as housekeeping } from '../app/api/cron/housekeeping/route';
import { GET as health } from '../app/api/health/route';
import { GET as exportSnapshot } from '../app/api/export/[snapshotId]/route';
import { GET as exportAccount } from '../app/api/account/export/route';

const t = await installTestDb();
const { pg } = t;
const SECRET = 'route-test-secret-value';
const WEBHOOK_SECRET = 'route-test-webhook-secret';
process.env.CRON_SECRET = SECRET;
process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;

const req = (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost${url}`, init);
const sign = (body: string, secret = WEBHOOK_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const hook = (event: string, body: string, signature: string | null) =>
  webhook(
    req('/api/webhook/github', {
      method: 'POST',
      body,
      headers: { 'x-github-event': event, ...(signature ? { 'x-hub-signature-256': signature } : {}) },
    }),
  );

await suiteAsync('POST /api/webhook/github', async () => {
  await testAsync('not configured -> 501', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    assert.equal((await hook('ping', '{}', sign('{}'))).status, 501);
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });
  await testAsync('missing signature -> 401', async () => {
    assert.equal((await hook('ping', '{}', null)).status, 401);
  });
  await testAsync('wrong signature (same length, different secret) -> 401', async () => {
    assert.equal((await hook('ping', '{}', sign('{}', 'another-secret'))).status, 401);
  });
  await testAsync('a signature over a different body -> 401', async () => {
    assert.equal((await hook('ping', '{"a":1}', sign('{}'))).status, 401);
  });
  await testAsync('a truncated signature -> 401 (length mismatch does not throw)', async () => {
    assert.equal((await hook('ping', '{}', sign('{}').slice(0, 20))).status, 401);
  });
  await testAsync('valid signature + ping -> 200 pong', async () => {
    const res = await hook('ping', '{}', sign('{}'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, pong: true });
  });
  await testAsync('valid signature, non-JSON push body -> 400', async () => {
    const res = await hook('push', 'not json at all', sign('not json at all'));
    assert.equal(res.status, 400);
  });
  await testAsync('valid signature, non-JSON installation body -> 400', async () => {
    assert.equal((await hook('installation', '<xml/>', sign('<xml/>'))).status, 400);
  });
  await testAsync('a push to the default branch clears the cached sha, matched case-insensitively', async () => {
    const u = await mkUser(pg);
    await pg.query(`update "user" set portfolio_repo='Owner/Repo', last_synced_sha='abc' where id=$1`, [u]);
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { id: 1, name: 'repo', full_name: 'owner/repo', default_branch: 'main', owner: { login: 'owner' } },
    });
    const res = await hook('push', body, sign(body));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, invalidated: 1 });
    assert.equal((await one<{ last_synced_sha: string | null }>(pg, `select last_synced_sha from "user" where id=$1`, [u]))?.last_synced_sha, null);
  });
  await testAsync('a push to another branch is ignored and clears nothing', async () => {
    const u = await mkUser(pg);
    await pg.query(`update "user" set portfolio_repo='o/r2', last_synced_sha='keep' where id=$1`, [u]);
    const body = JSON.stringify({
      ref: 'refs/heads/feature',
      repository: { id: 2, name: 'r2', full_name: 'o/r2', default_branch: 'main', owner: { login: 'o' } },
    });
    const res = await hook('push', body, sign(body));
    assert.equal(res.status, 200);
    assert.notEqual(((await res.json()) as { ignored?: string }).ignored, undefined);
    assert.equal((await one<{ last_synced_sha: string }>(pg, `select last_synced_sha from "user" where id=$1`, [u]))?.last_synced_sha, 'keep');
  });
});

type CronRoute = (r: NextRequest) => Promise<Response>;
const cronRoutes: Array<[string, CronRoute, string]> = [
  ['/api/cron/alerts', alerts as CronRoute, '/api/cron/alerts?dryRun=1'],
  ['/api/cron/sync', cronSync as CronRoute, '/api/cron/sync'],
  ['/api/cron/housekeeping', housekeeping as CronRoute, '/api/cron/housekeeping?scope=hourly'],
];
const cronAs = (route: CronRoute, url: string, headers: Record<string, string>) => route(req(url, { headers }));

for (const [name, route, url] of cronRoutes) {
  await suiteAsync(`GET ${name}`, async () => {
    await testAsync('CRON_SECRET unset -> 501 (disabled, never open)', async () => {
      delete process.env.CRON_SECRET;
      assert.equal((await cronAs(route, url, { 'x-cron-secret': SECRET })).status, 501);
      process.env.CRON_SECRET = SECRET;
    });
    await testAsync('no secret -> 401', async () => {
      assert.equal((await cronAs(route, url, {})).status, 401);
    });
    await testAsync('wrong secret (same length, shorter, longer, empty) -> 401', async () => {
      for (const bad of ['x'.repeat(SECRET.length), 'short', SECRET + 'extra', '']) {
        assert.equal((await cronAs(route, url, { 'x-cron-secret': bad })).status, 401, JSON.stringify(bad));
      }
      assert.equal((await cronAs(route, url, { authorization: 'Bearer wrong' })).status, 401);
    });
    await testAsync('right secret in x-cron-secret -> 200', async () => {
      const res = await cronAs(route, url, { 'x-cron-secret': SECRET });
      assert.equal(res.status, 200, await res.clone().text());
    });
    await testAsync('right secret as a bearer token -> 200', async () => {
      assert.equal((await cronAs(route, url, { authorization: `Bearer ${SECRET}` })).status, 200);
    });
  });
}

await suiteAsync('cron/sync: what the freshness check does with its candidates', async () => {
  await testAsync('a user with an unparseable repo is skipped, not an error', async () => {
    const u = await mkUser(pg);
    await pg.query(`update "user" set portfolio_repo='not a repo ref' where id=$1`, [u]);
    const res = await cronAs(cronSync as CronRoute, '/api/cron/sync', { 'x-cron-secret': SECRET });
    const body = (await res.json()) as { ok: boolean; skipped: number; checked: number; errors: string[] };
    assert.equal(body.ok, true);
    assert.ok(body.skipped >= 1);
    assert.equal(body.checked, 0);
    assert.deepEqual(body.errors, []);
  });
});

await suiteAsync('GET /api/health', async () => {
  const get = (headers: Record<string, string> = {}) => health(req('/api/health', { headers }));
  await testAsync('public + database up -> 200 {status:"ok"} and nothing else', async () => {
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
  await testAsync('public + database failing -> 503 {status:"degraded"} and nothing else', async () => {
    const real = (globalThis as { __testDb?: unknown }).__testDb;
    setTestDb({ execute: () => Promise.reject(new Error('connection refused')) });
    try {
      const res = await get();
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { status: 'degraded' });
    } finally {
      setTestDb(real);
    }
  });
  await testAsync('a wrong secret still gets only the shallow answer', async () => {
    const body = await (await get({ 'x-cron-secret': 'nope' })).json();
    assert.deepEqual(body, { status: 'ok' });
  });
  await testAsync('with the secret: detail, db up, and no secret values anywhere in it', async () => {
    const res = await get({ 'x-cron-secret': SECRET });
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text) as { db: { up: boolean }; deep: unknown };
    assert.equal(body.db.up, true);
    assert.ok(body.deep);
    assert.ok(!text.includes(SECRET), 'the cron secret must never be echoed');
    assert.ok(!text.includes(WEBHOOK_SECRET));
  });
});

await suiteAsync('GET /api/export/[snapshotId] and /api/account/export', async () => {
  const owner = await mkUser(pg);
  const stranger = await mkUser(pg);
  await pg.query(`insert into resume_snapshot (id, user_id, document, file_name) values ('snap-1', $1, '{"contact":{"fullName":"Ada Lovelace"}}'::jsonb, 'x.pdf')`, [owner]);
  const snap = (id: string, qs = '') =>
    exportSnapshot(req(`/api/export/${id}${qs}`), { params: Promise.resolve({ snapshotId: id }) });

  await testAsync('unauthenticated snapshot export -> 401', async () => {
    setSession(null);
    assert.equal((await snap('snap-1')).status, 401);
  });
  await testAsync("another user's snapshot -> 404 (indistinguishable from missing), no render attempted", async () => {
    setSession({ user: { id: stranger } });
    assert.equal((await snap('snap-1')).status, 404);
    assert.equal((await snap('no-such-snapshot')).status, 404);
  });
  await testAsync('presentation mode is PDF-only -> 400, before any lookup', async () => {
    setSession({ user: { id: owner } });
    assert.equal((await snap('snap-1', '?format=docx&mode=presentation')).status, 400);
  });
  await testAsync('the owner gets the file, in the format asked, uncached (renderers are stubbed)', async () => {
    setSession({ user: { id: owner } });
    const pdf = await snap('snap-1');
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store');
    assert.match(pdf.headers.get('content-disposition') ?? '', /attachment/);
    const docx = await snap('snap-1', '?format=docx');
    assert.match(docx.headers.get('content-type') ?? '', /wordprocessingml/);
  });
  await testAsync('unauthenticated account export -> 401', async () => {
    setSession(null);
    assert.equal((await exportAccount()).status, 401);
  });
  await testAsync("account export contains the caller's data only, and never a password hash", async () => {
    await pg.query(`update "user" set password_hash='scrypt$secret-hash-value', email='me@example.test' where id=$1`, [owner]);
    await mkRecord(pg, owner, { source: 'manual', state: 'approved', data: { name: 'OwnersOnlySkill', category: 'tool' } });
    await mkRecord(pg, stranger, { source: 'manual', state: 'approved', data: { name: 'StrangersSecretSkill', category: 'tool' } });
    setSession({ user: { id: owner } });
    const res = await exportAccount();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const text = await res.text();
    assert.ok(text.includes('OwnersOnlySkill'));
    assert.ok(!text.includes('StrangersSecretSkill'), "another user's data must not be in the export");
    assert.ok(!text.includes('scrypt$secret-hash-value'), 'the password hash must not be in the export');
    assert.equal((JSON.parse(text) as { account: { hasPassword: boolean } }).account.hasPassword, true);
  });
});

await t.close();
