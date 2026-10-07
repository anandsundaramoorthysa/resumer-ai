/**
 * lib/sync/github.ts against a stubbed fetch — no network, no token.
 */

import {
  fetchPortfolioCorpus,
  GithubRateLimitError,
  parseRepoRef,
  rateLimitMessage,
  selectCandidates,
} from '../lib/sync/github';
import type { TreeNode } from '../lib/sync/github';
import { suite, suiteAsync, test, testAsync, assert } from './harness.mjs';

suite('parseRepoRef', () => {
  test('forms that name a GitHub repository', () => {
    const ok: Array<[string, string, string]> = [
      ['owner/repo', 'owner', 'repo'],
      ['github.com/owner/repo', 'owner', 'repo'],
      ['www.github.com/owner/repo', 'owner', 'repo'],
      ['https://github.com/owner/repo', 'owner', 'repo'],
      ['https://github.com/o/r.git/', 'o', 'r'],
      ['http://github.com/o/r/', 'o', 'r'],
      ['github.com/o/r.git', 'o', 'r'],
      ['git@github.com:o/r.git', 'o', 'r'],
      ['  https://GitHub.com/O/R/tree/main  ', 'O', 'R'],
      ['Some-Org/my.site_v2', 'Some-Org', 'my.site_v2'],
    ];
    for (const [input, owner, repo] of ok) {
      assert.deepEqual(parseRepoRef(input), { owner, repo }, input);
    }
  });

  test('other hosts and non-names are refused', () => {
    for (const input of [
      'https://gitlab.com/o/r',
      'gitlab.com/o/r',
      'bitbucket.org/o/r',
      'https://github.com.evil.example/o/r',
      'https://evil.example/github.com/o/r',
      'ssh://git@github.com/o/r',
      'ftp://github.com/o/r',
      'git@gitlab.com:o/r.git',
      'https://github.com/o',
      'https://github.com/',
      'owner/..',
      'owner/repo?x=1',
      'owner/.git',
    ]) {
      assert.equal(parseRepoRef(input), null, input);
    }
  });
});

const node = (path: string, size = 100): TreeNode => ({ path, type: 'blob', size, sha: `sha-${path}` });

suite('selectCandidates (fair per-directory budget)', () => {
  test('REPRO: 45 component files no longer crowd out content/*', () => {
    const nodes = [
      ...Array.from({ length: 45 }, (_, i) => node(`components/about-${String(i).padStart(2, '0')}.tsx`)),
      node('content/experience.json'),
      node('content/projects.json'),
      node('data/skills.json'),
    ];
    const { selected, dropped } = selectCandidates(nodes);
    const paths = selected.map((n) => n.path);
    assert.equal(selected.length, 40);
    assert.ok(paths.includes('content/experience.json'));
    assert.ok(paths.includes('content/projects.json'));
    assert.ok(paths.includes('data/skills.json'));
    assert.equal(dropped, 48 - 40);
  });

  test('every directory is represented before any gets a second file', () => {
    const nodes = [
      ...Array.from({ length: 30 }, (_, i) => node(`a/work-${i}.json`)),
      ...Array.from({ length: 30 }, (_, i) => node(`z/work-${i}.json`)),
    ];
    const { selected } = selectCandidates(nodes);
    assert.equal(selected.filter((n) => n.path.startsWith('a/')).length, 20);
    assert.equal(selected.filter((n) => n.path.startsWith('z/')).length, 20);
  });

  test('total bytes are capped and the oversize and skipped are counted', () => {
    const big = Array.from({ length: 12 }, (_, i) => node(`content/f${i}.json`, 110_000));
    const { selected, dropped, oversize } = selectCandidates([
      ...big,
      node('content/huge.json', 500_000),
      node('node_modules/x/content/a.json'),
    ]);
    assert.ok(selected.reduce((s, n) => s + (n.size ?? 0), 0) <= 1_000_000);
    assert.equal(oversize, 1);
    assert.ok(dropped >= 3);
  });
});

type Call = { url: string };
function stubFetch(handler: (url: string, n: number) => Response) {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push({ url });
    return handler(url, calls.length);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });
const blob = (text: string, headers: Record<string, string> = {}) =>
  json({ encoding: 'base64', content: Buffer.from(text).toString('base64') }, headers);
const ref = { owner: 'o', repo: 'r' };

await suiteAsync('fetchPortfolioCorpus', async () => {
  await testAsync('a clean read reports nothing missing', async () => {
    const s = stubFetch((url) =>
      url.includes('/git/trees/')
        ? json({ tree: [node('content/a.json'), node('content/b.json')] })
        : blob('{"x":1}'),
    );
    try {
      const c = await fetchPortfolioCorpus(ref, 't', 'abc');
      assert.equal(c.files.length, 2);
      assert.deepEqual([c.incomplete, c.unread], [[], []]);
    } finally {
      s.restore();
    }
  });

  await testAsync('REPRO: a blob that fails is reported, not swallowed', async () => {
    const s = stubFetch((url) =>
      url.includes('/git/trees/')
        ? json({ tree: [node('content/a.json'), node('content/b.json')] })
        : url.includes('sha-content%2Fb.json')
          ? new Response('{}', { status: 500 })
          : blob('{"x":1}'),
    );
    try {
      const c = await fetchPortfolioCorpus(ref, 't', 'abc');
      assert.equal(c.files.length, 1);
      assert.equal(c.incomplete.length, 1);
      assert.match(c.incomplete[0], /1 file could not be read/);
    } finally {
      s.restore();
    }
  });

  await testAsync('a truncated tree is partial', async () => {
    const s = stubFetch((url) =>
      url.includes('/git/trees/') ? json({ tree: [node('content/a.json')], truncated: true }) : blob('{}'),
    );
    try {
      const c = await fetchPortfolioCorpus(ref, 't', 'abc');
      assert.equal(c.files.length, 1);
      assert.match(c.incomplete[0], /only part of this repository/);
    } finally {
      s.restore();
    }
  });

  await testAsync('files over the budget are "unread", not incomplete', async () => {
    const s = stubFetch((url) =>
      url.includes('/git/trees/')
        ? json({ tree: [node('content/a.json'), node('content/huge.json', 999_999)] })
        : blob('{}'),
    );
    try {
      const c = await fetchPortfolioCorpus(ref, 't', 'abc');
      assert.deepEqual(c.incomplete, []);
      assert.match(c.unread[0], /1 content file was over the size or count limit/);
    } finally {
      s.restore();
    }
  });

  await testAsync('403 + X-RateLimit-Remaining 0 mid-fetch stops with a partial result naming the time', async () => {
    const reset = Math.floor(Date.UTC(2026, 9, 7, 10, 5) / 1000);
    const files = Array.from({ length: 20 }, (_, i) => node(`content/f${String(i).padStart(2, '0')}.json`));
    const s = stubFetch((url, n) => {
      if (url.includes('/git/trees/')) return json({ tree: files });
      return n <= 4
        ? blob('{"ok":1}')
        : new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
    });
    try {
      const c = await fetchPortfolioCorpus(ref, 't', 'abc');
      assert.ok(c.files.length >= 1 && c.files.length < 20);
      assert.ok(c.incomplete.includes('GitHub rate limit — try again at 10:05 UTC'));
      assert.ok(s.calls.length < 22, 'stopped instead of hammering');
    } finally {
      s.restore();
    }
  });

  await testAsync('REPRO: a rate limit with nothing read throws the limit — never "repo empty"', async () => {
    const s = stubFetch((url) =>
      url.includes('/git/trees/')
        ? json({ tree: [node('content/a.json')] })
        : new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    );
    try {
      await assert.rejects(fetchPortfolioCorpus(ref, 't', 'abc'), (e: unknown) => {
        assert.ok(e instanceof GithubRateLimitError);
        assert.match((e as Error).message, /^GitHub rate limit — try again at \d\d:\d\d UTC$/);
        return true;
      });
    } finally {
      s.restore();
    }
  });

  await testAsync('a rate limit on the tree request throws too; a plain 403 does not look like one', async () => {
    const limited = stubFetch(() => new Response('x', { status: 403, headers: { 'retry-after': '30' } }));
    try {
      await assert.rejects(fetchPortfolioCorpus(ref, 't', 'abc'), GithubRateLimitError);
    } finally {
      limited.restore();
    }
    const denied = stubFetch(() => new Response('forbidden', { status: 403 }));
    try {
      await assert.rejects(fetchPortfolioCorpus(ref, 't', 'abc'), (e: unknown) => {
        assert.ok(!(e instanceof GithubRateLimitError));
        assert.match((e as Error).message, /403/);
        return true;
      });
    } finally {
      denied.restore();
    }
  });

  await testAsync('the success that spends the last request stops further calls', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const s = stubFetch((url, n) =>
      url.includes('/git/trees/')
        ? json({ tree: Array.from({ length: 12 }, (_, i) => node(`content/f${i}.json`)) })
        : blob('{}', n >= 3 ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } : {}),
    );
    try {
      const c = await fetchPortfolioCorpus(ref, 't', 'abc');
      assert.ok(c.files.length < 12);
      assert.match(c.incomplete[0], /rate limit/);
    } finally {
      s.restore();
    }
  });

  test('rateLimitMessage is HH:MM UTC', () => {
    assert.equal(rateLimitMessage(new Date(Date.UTC(2026, 0, 1, 3, 7))), 'GitHub rate limit — try again at 03:07 UTC');
  });
});
