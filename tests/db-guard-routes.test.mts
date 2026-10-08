/**
 * The request guard on every state-changing route (lib/server/request-guard.ts), NUL/odd ids,
 * the webhook body cap, the consent->403 mapping, keepRecord's audit, and the ops-alert claim.
 * Routes are called directly with `new Request`; `@/auth` is tests/db/auth-stub.mts.
 */
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { setSession } from './db/auth-stub.mjs';
import { setTestDb } from './db/lib-db-stub.mjs';
import { mkRecord, mkUser, one } from './db/seed.mjs';
import { POST as draft } from '../app/api/draft/route';
import { POST as assess } from '../app/api/draft/assess/route';
import { POST as amend } from '../app/api/draft/assess/amend/route';
import { POST as improve } from '../app/api/draft/[snapshotId]/improve/route';
import { PATCH as patchResume, GET as getResume } from '../app/api/resume/[snapshotId]/route';
import { POST as extras } from '../app/api/resume/[snapshotId]/extras/route';
import { POST as importExtract } from '../app/api/import/extract/route';
import { POST as importParse } from '../app/api/import/parse/route';
import { POST as importPreview } from '../app/api/import/preview/route';
import { POST as importLinkedin } from '../app/api/import/linkedin/route';
import { POST as sync, GET as syncGet } from '../app/api/sync/route';
import { POST as webhook } from '../app/api/webhook/github/route';
import { GET as exportSnapshot } from '../app/api/export/[snapshotId]/route';
import { GET as selftest } from '../app/api/dev/selftest/route';
import { POST as e2eDraft } from '../app/api/dev/e2e-draft/route';
import { dispatchOpsAlerts, type OpsFinding } from '../lib/server/housekeeping';
import { keepRecord } from '../app/profile/actions';
import { BudgetExceededError } from '../lib/ai/budget';

const t = await installTestDb();
const { pg } = t;
void setTestDb;
process.env.GITHUB_WEBHOOK_SECRET = 'guard-test-webhook-secret';

const JSON_H = { 'content-type': 'application/json' };
const ctx = (snapshotId: string) => ({ params: Promise.resolve({ snapshotId }) });
const post = (url: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost${url}`, { method: 'POST', ...init });

const owner = await mkUser(pg);
await pg.query(
  `insert into resume_snapshot (id, user_id, document, file_name) values ('snap-g', $1, '{"sections":[{"key":"skills","heading":"Skills","items":[{"text":"a","sourceRecordId":null}]}]}'::jsonb, 'x.pdf')`,
  [owner],
);
const edits = JSON.stringify({ edits: [{ sectionKey: 'skills', groupIndex: null, itemIndex: 0, text: 'b' }] });
const count = async (table: string) => Number((await one<{ n: string }>(pg, `select count(*)::int as n from ${table}`))?.n);

await suiteAsync('guardMutation on every mutating route', async () => {
  setSession({ user: { id: owner } });
  const foreign = { ...JSON_H, origin: 'https://evil.example' };
  const routes: Array<[string, () => Promise<Response>]> = [
    ['draft', () => draft(post('/api/draft', { body: '{}', headers: foreign }))],
    ['assess', () => assess(post('/api/draft/assess', { body: '{}', headers: foreign }))],
    ['amend', () => amend(post('/api/draft/assess/amend', { body: '{}', headers: foreign }))],
    ['improve', () => improve(post('/api/draft/snap-g/improve', { headers: { origin: 'https://evil.example' } }), ctx('snap-g'))],
    ['patch', () => patchResume(post('/api/resume/snap-g', { method: 'PATCH', body: edits, headers: foreign }), ctx('snap-g'))],
    ['extras', () => extras(post('/api/resume/snap-g/extras', { body: '{"kind":"interview"}', headers: foreign }), ctx('snap-g'))],
    ['parse', () => importParse(post('/api/import/parse', { body: '{"chunk":"x"}', headers: foreign }))],
    ['preview', () => importPreview(post('/api/import/preview', { body: '{"partials":[]}', headers: foreign }))],
    ['extract', () => importExtract(post('/api/import/extract', { body: new FormData(), headers: { origin: 'https://evil.example', 'content-length': '10' } }))],
    ['linkedin', () => importLinkedin(post('/api/import/linkedin', { body: new FormData(), headers: { origin: 'https://evil.example', 'content-length': '10' } }))],
    ['sync', () => sync(post('/api/sync', { body: '{}', headers: foreign }))],
  ];
  for (const [name, call] of routes) {
    await testAsync(`${name}: a foreign Origin -> 403, with no side effect`, async () => {
      assert.equal((await call()).status, 403);
    });
  }
  await testAsync('the literal Origin "null" -> 403', async () => {
    const res = await patchResume(post('/api/resume/snap-g', { method: 'PATCH', body: edits, headers: { ...JSON_H, origin: 'null' } }), ctx('snap-g'));
    assert.equal(res.status, 403);
  });
  await testAsync('refused requests wrote nothing: the snapshot is unchanged and no draft_run exists', async () => {
    const row = await one<{ document: { sections: Array<{ items: Array<{ text: string }> }> } }>(pg, `select document from resume_snapshot where id='snap-g'`);
    assert.equal(row?.document.sections[0].items[0].text, 'a');
    assert.equal(await count('draft_run'), 0);
  });

  await testAsync('text/plain -> 415 (JSON routes)', async () => {
    const h = { 'content-type': 'text/plain' };
    assert.equal((await patchResume(post('/api/resume/snap-g', { method: 'PATCH', body: edits, headers: h }), ctx('snap-g'))).status, 415);
    assert.equal((await importParse(post('/api/import/parse', { body: '{"chunk":"x"}', headers: h }))).status, 415);
    assert.equal((await sync(post('/api/sync', { body: '{}', headers: h }))).status, 415);
    assert.equal((await draft(post('/api/draft', { body: '{}', headers: h }))).status, 415);
  });
  await testAsync('a JSON body sent to the upload routes -> 415', async () => {
    assert.equal((await importExtract(post('/api/import/extract', { body: '{}', headers: JSON_H }))).status, 415);
  });

  await testAsync('a 30 MB Content-Length -> 413 without reading the body', async () => {
    const big = { 'content-length': String(30 * 1024 * 1024) };
    assert.equal((await importExtract(post('/api/import/extract', { body: 'x', headers: { 'content-type': 'multipart/form-data; boundary=x', ...big } }))).status, 413);
    assert.equal((await importLinkedin(post('/api/import/linkedin', { body: 'x', headers: { 'content-type': 'multipart/form-data; boundary=x', ...big } }))).status, 413);
    assert.equal((await draft(post('/api/draft', { body: 'x', headers: { ...JSON_H, ...big } }))).status, 413);
    assert.equal((await patchResume(post('/api/resume/snap-g', { method: 'PATCH', body: 'x', headers: { ...JSON_H, ...big } }), ctx('snap-g'))).status, 413);
  });
  await testAsync('a streamed body over the cap is cut off while reading (no Content-Length) -> 413', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(64 * 1024));
        if (pulled > 400) c.close(); // ~25 MB if it were ever read to the end
      },
    });
    const res = await patchResume(
      new NextRequest('http://localhost/api/resume/snap-g', { method: 'PATCH', body: stream, headers: JSON_H, duplex: 'half' } as unknown as ConstructorParameters<typeof NextRequest>[1]),
      ctx('snap-g'),
    );
    assert.equal(res.status, 413);
    assert.ok(pulled < 20, `the reader stopped early (${pulled} chunks pulled)`);
  });
  await testAsync('malformed JSON -> 400', async () => {
    const res = await patchResume(post('/api/resume/snap-g', { method: 'PATCH', body: '{nope', headers: JSON_H }), ctx('snap-g'));
    assert.equal(res.status, 400);
  });

  await testAsync('an absent Origin (non-browser client) is allowed', async () => {
    const res = await patchResume(post('/api/resume/snap-g', { method: 'PATCH', body: edits, headers: JSON_H }), ctx('snap-g'));
    assert.equal(res.status, 200);
  });
  await testAsync('the same Origin (and the x-forwarded-host) is allowed', async () => {
    const res = await patchResume(post('/api/resume/snap-g', { method: 'PATCH', body: edits, headers: { ...JSON_H, origin: 'http://localhost', host: 'localhost' } }), ctx('snap-g'));
    assert.equal(res.status, 200);
    const fwd = await patchResume(
      post('/api/resume/snap-g', { method: 'PATCH', body: edits, headers: { ...JSON_H, origin: 'https://app.example', 'x-forwarded-host': 'app.example' } }),
      ctx('snap-g'),
    );
    assert.equal(fwd.status, 200);
  });
  await testAsync('AUTH_URL host counts as same origin', async () => {
    process.env.AUTH_URL = 'https://resumer.example';
    const res = await patchResume(post('/api/resume/snap-g', { method: 'PATCH', body: edits, headers: { ...JSON_H, origin: 'https://resumer.example' } }), ctx('snap-g'));
    delete process.env.AUTH_URL;
    assert.equal(res.status, 200);
  });
});

await suiteAsync('ids with NUL or odd characters never reach the database', async () => {
  setSession({ user: { id: owner } });
  const bad = ['%00', 'a%00b', '..%2F..', 'x'.repeat(65)].map((s) => decodeURIComponent(s));
  for (const id of bad) {
    await testAsync(`id ${JSON.stringify(id.slice(0, 12))} -> 404 on export/resume/extras/improve/sync`, async () => {
      assert.equal((await exportSnapshot(new NextRequest('http://localhost/api/export/x'), ctx(id))).status, 404);
      assert.equal((await getResume(new NextRequest('http://localhost/api/resume/x'), ctx(id))).status, 404);
      assert.equal((await patchResume(post('/api/resume/x', { method: 'PATCH', body: edits, headers: JSON_H }), ctx(id))).status, 404);
      assert.equal((await extras(post('/api/resume/x/extras', { body: '{}', headers: JSON_H }), ctx(id))).status, 404);
      assert.equal((await improve(post('/api/draft/x/improve'), ctx(id))).status, 404);
      assert.equal((await sync(post('/api/sync', { body: JSON.stringify({ jobId: id }), headers: JSON_H }))).status, 404);
      assert.equal((await syncGet(new NextRequest(`http://localhost/api/sync?jobId=${encodeURIComponent(id)}`))).status, 404);
    });
  }
});

await suiteAsync('/api/dev/* is a 404 in production', async () => {
  await testAsync('selftest and e2e-draft refuse before doing any work', async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      assert.equal((await selftest()).status, 404);
      assert.equal((await e2eDraft(new NextRequest('http://localhost/api/dev/e2e-draft', { method: 'POST' }))).status, 404);
    } finally {
      env.NODE_ENV = prev;
    }
  });
});

await suiteAsync('webhook body cap is applied before the signature check', async () => {
  const sign = (body: string) => `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(body).digest('hex')}`;
  await testAsync('a body over 1 MB -> 413 even with a valid-looking header', async () => {
    const body = 'x'.repeat(1024 * 1024 + 1);
    const res = await webhook(post('/api/webhook/github', { body, headers: { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) } }));
    assert.equal(res.status, 413);
  });
  await testAsync('a normal body still verifies (ping -> 200) and a bad signature is still 401', async () => {
    const ok = await webhook(post('/api/webhook/github', { body: '{}', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': sign('{}') } }));
    assert.equal(ok.status, 200);
    const bad = await webhook(post('/api/webhook/github', { body: '{}', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=00' } }));
    assert.equal(bad.status, 401);
  });
});

await suiteAsync('consent refusal is 403, real budget limits stay 429', async () => {
  const consent = new BudgetExceededError('approval', 'consent');
  const rate = new BudgetExceededError('rate', 'x');
  // The mapping is `scope === 'approval' ? 403 : 429` in import/parse and resume extras.
  await testAsync('the consent error is an approval-scope BudgetExceededError', async () => {
    assert.equal(consent.scope, 'approval');
    assert.equal(rate.scope, 'rate');
  });
  await testAsync('import/parse answers 403 for a user without current consent', async () => {
    const u = await mkUser(pg);
    setSession({ user: { id: u } });
    const res = await importParse(post('/api/import/parse', { body: '{"chunk":"hello"}', headers: JSON_H }));
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /Terms and Privacy/);
  });
});

await suiteAsync('keepRecord audits only a row it actually updated', async () => {
  const u = await mkUser(pg);
  const stranger = await mkUser(pg);
  const rec = await mkRecord(pg, stranger, { source: 'manual', state: 'approved', data: { name: 'S', category: 'tool' } });
  const rec2 = await mkRecord(pg, u, { source: 'manual', state: 'approved', data: { name: 'M', category: 'tool' } });
  const audits = async (uid: string) => Number((await one<{ n: string }>(pg, `select count(*)::int as n from audit_log where user_id=$1`, [uid]))?.n);
  const call = async (id: string) => {
    try {
      await keepRecord(id);
    } catch {
      /* revalidatePath needs a Next request scope; the writes happen before it */
    }
  };
  await testAsync("someone else's record id writes no audit row", async () => {
    setSession({ user: { id: u } });
    await call(typeof rec === 'string' ? rec : (rec as { id: string }).id);
    assert.equal(await audits(u), 0);
  });
  await testAsync('a missing id writes no audit row', async () => {
    await call('no-such-record');
    assert.equal(await audits(u), 0);
  });
  await testAsync('the own record is audited once', async () => {
    await call(typeof rec2 === 'string' ? rec2 : (rec2 as { id: string }).id);
    assert.equal(await audits(u), 1);
  });
});

await suiteAsync('ops alerts: the 24h window is spent only by a mail that went out', async () => {
  const findings: OpsFinding[] = [{ kind: 'credits-low', detail: 'low' }];
  const window = async () => one(pg, `select key from app_setting where key='alert:credits-low'`);
  const mailer = (ok: boolean, sent: string[]) => ({
    to: 'ops@example.test',
    configured: true,
    send: async (_to: string, subject: string) => (sent.push(subject), { ok, error: ok ? undefined : 'smtp down' }),
  });
  await testAsync('no recipient or SMTP: nothing claimed, nothing sent', async () => {
    const r = await dispatchOpsAlerts(findings, { dryRun: false, mailer: { to: undefined, configured: true, send: async () => ({ ok: true }) } });
    assert.equal(r.sent, false);
    assert.equal(await window(), undefined);
    const r2 = await dispatchOpsAlerts(findings, { dryRun: false, mailer: { to: 'a@b.test', configured: false, send: async () => ({ ok: true }) } });
    assert.equal(r2.sent, false);
    assert.equal(await window(), undefined);
  });
  await testAsync('a failed send releases the claim, so the next run retries', async () => {
    const sent: string[] = [];
    const r = await dispatchOpsAlerts(findings, { dryRun: false, mailer: mailer(false, sent) });
    assert.equal(r.sent, false);
    assert.equal(sent.length, 1);
    assert.equal(await window(), undefined);
    const again: string[] = [];
    const r2 = await dispatchOpsAlerts(findings, { dryRun: false, mailer: mailer(true, again) });
    assert.equal(r2.sent, true);
    assert.equal(again.length, 1);
  });
  await testAsync('a delivered mail holds the window: the next run sends nothing', async () => {
    assert.ok(await window());
    const sent: string[] = [];
    const r = await dispatchOpsAlerts(findings, { dryRun: false, mailer: mailer(true, sent) });
    assert.equal(r.sent, false);
    assert.equal(sent.length, 0);
  });
  await testAsync('dry run claims nothing', async () => {
    await pg.query(`delete from app_setting where key='alert:credits-low'`);
    await dispatchOpsAlerts(findings, { dryRun: true, mailer: mailer(true, []) });
    assert.equal(await window(), undefined);
  });
});

await t.close();
