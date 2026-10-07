/**
 * Webhook decisions (lib/sync/webhook.ts) against fixture payloads shaped like GitHub's.
 */

import { createHmac } from 'node:crypto';
import { decideWebhook, verifySignature } from '../lib/sync/webhook';
import { suite, suiteAsync, test, testAsync, assert } from './harness.mjs';

const repository = {
  id: 42,
  name: 'portfolio',
  full_name: 'Anand/portfolio',
  default_branch: 'main',
  owner: { login: 'Anand' },
};

suite('which deliveries clear the cached SHA', () => {
  test('a push to the default branch does', () => {
    assert.deepEqual(decideWebhook('push', { ref: 'refs/heads/main', repository }), {
      kind: 'invalidate',
      fullName: 'Anand/portfolio',
    });
  });

  test('a push to another branch or a tag does not', () => {
    for (const ref of ['refs/heads/feature/x', 'refs/tags/v1', 'refs/heads/main-old']) {
      assert.equal(decideWebhook('push', { ref, repository }).kind, 'ignore', ref);
    }
  });

  test('a branch deletion does not', () => {
    assert.equal(decideWebhook('push', { ref: 'refs/heads/main', deleted: true, repository }).kind, 'ignore');
  });

  test('REPRO: star, issue, fork, watch and the rest no longer invalidate', () => {
    for (const event of ['star', 'issues', 'issue_comment', 'fork', 'watch', 'pull_request', 'release', null]) {
      assert.equal(decideWebhook(event, { action: 'created', repository }).kind, 'ignore', String(event));
    }
  });

  test('no repository, nothing to do', () => {
    assert.deepEqual(decideWebhook('push', {}), { kind: 'ignore', reason: 'no repository' });
  });
});

suite('renamed and transferred repositories', () => {
  test('a rename names the old name in changes.repository.name.from', () => {
    const a = decideWebhook('repository', {
      action: 'renamed',
      changes: { repository: { name: { from: 'old-portfolio' } } },
      repository,
    });
    assert.deepEqual(a, { kind: 'rename', from: 'Anand/old-portfolio', to: 'Anand/portfolio' });
  });

  test('a transfer names the old owner', () => {
    const a = decideWebhook('repository', {
      action: 'transferred',
      changes: { owner: { from: { user: { login: 'someone' } } } },
      repository,
    });
    assert.deepEqual(a, { kind: 'rename', from: 'someone/portfolio', to: 'Anand/portfolio' });
  });

  test('other repository actions and a rename that changed nothing are ignored', () => {
    assert.equal(decideWebhook('repository', { action: 'edited', repository }).kind, 'ignore');
    assert.equal(
      decideWebhook('repository', { action: 'renamed', changes: { repository: { name: { from: 'PORTFOLIO' } } }, repository }).kind,
      'ignore',
    );
  });
});

suite('signature check', () => {
  const body = JSON.stringify({ hello: 'world' });
  const good = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  test('accepts the right signature, refuses wrong, short and tampered ones', () => {
    assert.equal(verifySignature(body, good, 's3cret'), true);
    assert.equal(verifySignature(body, good, 'other'), false);
    assert.equal(verifySignature(body + ' ', good, 's3cret'), false);
    assert.equal(verifySignature(body, 'sha256=abc', 's3cret'), false);
    assert.equal(verifySignature(body, '', 's3cret'), false);
  });

  test('is checked on the raw text, so unparseable bodies are judged on the signature first', () => {
    const junk = 'not json at all {';
    const sig = `sha256=${createHmac('sha256', 's3cret').update(junk).digest('hex')}`;
    assert.equal(verifySignature(junk, sig, 's3cret'), true);
    assert.equal(verifySignature(junk, good, 's3cret'), false);
  });
});

await suiteAsync('the route: signature before parsing (no database is reached)', async () => {
  process.env.GITHUB_WEBHOOK_SECRET = 's3cret';
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../app/api/webhook/github/route');
  const send = (body: string, sig: string | null, event = 'push') =>
    POST(
      new NextRequest('https://app.example.com/api/webhook/github', {
        method: 'POST',
        body,
        headers: { 'x-github-event': event, ...(sig ? { 'x-hub-signature-256': sig } : {}) },
      }),
    );
  const sign = (b: string) => `sha256=${createHmac('sha256', 's3cret').update(b).digest('hex')}`;

  await testAsync('unsigned or wrongly signed junk is 401, never a parse error', async () => {
    assert.equal((await send('{{{ not json', null)).status, 401);
    assert.equal((await send('{{{ not json', sign('other'))).status, 401);
  });

  await testAsync('correctly signed junk is 400', async () => {
    const junk = '{{{ not json';
    assert.equal((await send(junk, sign(junk))).status, 400);
  });

  await testAsync('signed star event and non-default-branch push are acknowledged and ignored', async () => {
    const star = JSON.stringify({ action: 'created', repository });
    const r1 = await send(star, sign(star), 'star');
    assert.equal(r1.status, 200);
    assert.match(JSON.stringify(await r1.json()), /ignored/);
    const push = JSON.stringify({ ref: 'refs/heads/dev', repository });
    const r2 = await send(push, sign(push));
    assert.match(JSON.stringify(await r2.json()), /not the default branch/);
  });

  await testAsync('ping still answers', async () => {
    const b = '{}';
    assert.equal((await (await send(b, sign(b), 'ping')).json() as { pong?: boolean }).pong, true);
  });
});
