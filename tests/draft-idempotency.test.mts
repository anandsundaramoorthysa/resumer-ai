/**
 * Draft idempotency — lib/server/draft-idempotency.ts, lib/pipeline/metered-budget.ts,
 * lib/pipeline/early-persist.ts and the stale-run reaper.
 *
 * The decision logic runs against an in-memory store that enforces the same uniqueness the
 * partial index does. The SQL itself (partial unique index, ON CONFLICT, retire, reaper)
 * is proven separately on PGlite against the real Drizzle schema.
 */

import {
  claimDraftRun,
  draftStatus,
  normalizeIdempotencyKey,
  runningFreshMs,
  type ClaimedRunRow,
  type DraftRunStore,
} from '../lib/server/draft-idempotency';
const RUNNING_FRESH_MS = runningFreshMs();
import { MeteredBudget } from '../lib/pipeline/metered-budget';
import { salvagedCompletePayload } from '../lib/pipeline/early-persist';
import { reapStaleDraftRuns } from '../lib/server/housekeeping';
import { suiteAsync, testAsync, assert } from './harness.mjs';

class MemStore implements DraftRunStore {
  rows: Array<ClaimedRunRow & { userId: string; key: string | null }> = [];
  private n = 0;
  async insertClaim(userId: string, key: string | null, startedAt: Date) {
    if (key && this.rows.some((r) => r.userId === userId && r.key === key)) return null;
    const id = `run${++this.n}`;
    this.rows.push({ id, userId, key, status: 'running', startedAt, snapshotId: null, errorKind: null });
    return id;
  }
  async find(userId: string, key: string) {
    return this.rows.find((r) => r.userId === userId && r.key === key) ?? null;
  }
  async retire(userId: string, key: string, runId: string) {
    const r = this.rows.find((x) => x.id === runId && x.userId === userId && x.key === key && !x.snapshotId);
    if (!r) return false;
    r.status = 'failed';
    r.errorKind = 'abandoned';
    r.key = `${key}:abandoned:${r.id}`;
    return true;
  }
}

const T0 = new Date('2026-10-08T10:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

await suiteAsync('draft idempotency', async () => {
  await testAsync('keys are bounded and printable', async () => {
    assert(normalizeIdempotencyKey('3f2a9c1e-aaaa-bbbb-cccc-123456789abc') !== null, 'uuid ok');
    assert(normalizeIdempotencyKey('short') === null, 'too short');
    assert(normalizeIdempotencyKey('x'.repeat(101)) === null, 'too long');
    assert(normalizeIdempotencyKey("abc'; drop table--") === null, 'junk refused');
    assert(normalizeIdempotencyKey(undefined) === null && normalizeIdempotencyKey(null) === null, 'absent');
  });

  await testAsync('(a) a new key proceeds; no key always proceeds', async () => {
    const s = new MemStore();
    const a = await claimDraftRun(s, 'u1', 'key-aaaaaaaa', T0);
    assert(a.kind === 'new' && a.runId === 'run1', JSON.stringify(a));
    const b = await claimDraftRun(s, 'u1', null, T0);
    const c = await claimDraftRun(s, 'u1', null, T0);
    assert(b.kind === 'new' && c.kind === 'new', 'keyless claims never collide');
  });

  await testAsync('two concurrent claims of one key: exactly one winner', async () => {
    const s = new MemStore();
    const claims = await Promise.all([
      claimDraftRun(s, 'u1', 'key-race-0001', T0),
      claimDraftRun(s, 'u1', 'key-race-0001', T0),
      claimDraftRun(s, 'u1', 'key-race-0001', T0),
    ]);
    assert.equal(claims.filter((c) => c.kind === 'new').length, 1, JSON.stringify(claims));
    assert.equal(claims.filter((c) => c.kind === 'running').length, 2, JSON.stringify(claims));
    assert.equal(s.rows.length, 1, 'one row, one pipeline');
  });

  await testAsync('keys are per user', async () => {
    const s = new MemStore();
    const a = await claimDraftRun(s, 'u1', 'key-shared-01', T0);
    const b = await claimDraftRun(s, 'u2', 'key-shared-01', T0);
    assert(a.kind === 'new' && b.kind === 'new', 'same key, different users');
  });

  await testAsync('(b) retry after completion replays the snapshot and starts nothing', async () => {
    const s = new MemStore();
    let pipelineRuns = 0;
    let modelCalls = 0;
    const handle = async () => {
      const claim = await claimDraftRun(s, 'u1', 'key-done-0001', later(5_000));
      if (claim.kind !== 'new') return claim;
      pipelineRuns++; // would call the models
      modelCalls += 7;
      return claim;
    };
    const first = await handle();
    assert(first.kind === 'new');
    // The run finishes: the route's finish() records success + snapshot.
    const row = s.rows[0];
    row.status = 'success';
    row.snapshotId = 'snap-1';

    const retry = await handle();
    assert(retry.kind === 'done' && retry.snapshotId === 'snap-1', JSON.stringify(retry));
    assert.equal(pipelineRuns, 1, 'the pipeline ran once');
    assert.equal(modelCalls, 7, 'zero provider calls for the retry');
    assert.equal(s.rows.length, 1, 'no duplicate row');
  });

  await testAsync('(b) a persisted-but-still-rendering run is already done', async () => {
    const s = new MemStore();
    await claimDraftRun(s, 'u1', 'key-early-001', T0);
    s.rows[0].snapshotId = 'snap-early'; // status still running: render in progress
    const r = await claimDraftRun(s, 'u1', 'key-early-001', later(10_000));
    assert(r.kind === 'done' && r.snapshotId === 'snap-early', JSON.stringify(r));
    const st = await draftStatus(s, 'u1', 'key-early-001', later(10_000));
    assert(st.state === 'done' && st.snapshotId === 'snap-early', JSON.stringify(st));
  });

  await testAsync('(c) retry while running is refused, not run twice', async () => {
    const s = new MemStore();
    await claimDraftRun(s, 'u1', 'key-busy-0001', T0);
    const r = await claimDraftRun(s, 'u1', 'key-busy-0001', later(RUNNING_FRESH_MS - 1));
    assert(r.kind === 'running', JSON.stringify(r));
    assert.equal(s.rows.length, 1);
    const st = await draftStatus(s, 'u1', 'key-busy-0001', later(1_000));
    assert.equal(st.state, 'running');
  });

  await testAsync('(d) a stale unfinished run is taken over with the same key', async () => {
    const s = new MemStore();
    await claimDraftRun(s, 'u1', 'key-stale-001', T0);
    const r = await claimDraftRun(s, 'u1', 'key-stale-001', later(RUNNING_FRESH_MS + 1));
    assert(r.kind === 'new' && r.runId === 'run2', JSON.stringify(r));
    assert.equal(s.rows[0].errorKind, 'abandoned');
    assert.equal(s.rows[0].status, 'failed');
    assert.equal(s.rows[1].key, 'key-stale-001', 'the new row holds the key');
    const st = await draftStatus(s, 'u1', 'key-stale-001', later(RUNNING_FRESH_MS + 2));
    assert.equal(st.state, 'running', 'the takeover is now the live run');
  });

  await testAsync('(d) a failed run is retried under the same key; status says failed first', async () => {
    const s = new MemStore();
    await claimDraftRun(s, 'u1', 'key-fail-0001', T0);
    s.rows[0].status = 'failed';
    const st = await draftStatus(s, 'u1', 'key-fail-0001', later(1_000));
    assert.equal(st.state, 'failed');
    const r = await claimDraftRun(s, 'u1', 'key-fail-0001', later(2_000));
    assert(r.kind === 'new', JSON.stringify(r));
  });

  await testAsync('a persisted run is never retired by a takeover', async () => {
    const s = new MemStore();
    await claimDraftRun(s, 'u1', 'key-keep-0001', T0);
    s.rows[0].snapshotId = 'snap-x';
    s.rows[0].status = 'failed'; // odd, but the snapshot must win
    assert.equal(await s.retire('u1', 'key-keep-0001', 'run1'), false);
  });

  await testAsync('concurrent takeovers of a stale run: one winner', async () => {
    const s = new MemStore();
    await claimDraftRun(s, 'u1', 'key-take-0001', T0);
    const at = later(RUNNING_FRESH_MS + 5_000);
    const out = await Promise.all([
      claimDraftRun(s, 'u1', 'key-take-0001', at),
      claimDraftRun(s, 'u1', 'key-take-0001', at),
    ]);
    assert.equal(out.filter((c) => c.kind === 'new').length, 1, JSON.stringify(out));
    assert.equal(s.rows.filter((r) => r.key === 'key-take-0001').length, 1, 'one live holder');
  });

  await testAsync('status: unknown key', async () => {
    const st = await draftStatus(new MemStore(), 'u1', 'key-none-0001');
    assert.equal(st.state, 'unknown');
  });

  await testAsync('status never crosses users', async () => {
    const s = new MemStore();
    await claimDraftRun(s, 'u1', 'key-priv-0001', T0);
    const st = await draftStatus(s, 'u2', 'key-priv-0001', later(1));
    assert.equal(st.state, 'unknown');
  });
});

await suiteAsync('freshness window', async () => {
  await testAsync('follows the pipeline budget, with margin, and stays under the reaper cutoff', async () => {
    assert.equal(runningFreshMs(280_000), 300_000, 'vercel');
    assert.equal(runningFreshMs(20_000), 60_000, 'netlify floor');
    assert(runningFreshMs(280_000) < 15 * 60_000, 'reaper cutoff is larger');
  });
  await testAsync('retry at window-1 is refused, at window+1 takes over', async () => {
    const s = new MemStore();
    const w = runningFreshMs();
    await claimDraftRun(s, 'u1', 'key-win-00001', T0);
    assert.equal((await claimDraftRun(s, 'u1', 'key-win-00001', later(w - 1))).kind, 'running');
    assert.equal((await claimDraftRun(s, 'u1', 'key-win-00001', later(w + 1))).kind, 'new');
  });
});

await suiteAsync('metered daily usage', async () => {
  await testAsync('usage is recorded per call, and the final flush adds only the remainder', async () => {
    const sent: Array<{ calls: number; tokens: number }> = [];
    const b = new MeteredBudget(async (u) => void sent.push(u));
    b.record(100);
    b.record(50);
    await b.flush();
    b.recordFailedAttempt(30);
    await b.flush();
    await b.flush(); // nothing new: must not double count
    const total = sent.reduce((a, u) => ({ calls: a.calls + u.calls, tokens: a.tokens + u.tokens }), { calls: 0, tokens: 0 });
    assert.deepEqual(total, b.snapshot());
    assert.deepEqual(total, { calls: 3, tokens: 180 });
  });

  await testAsync('a killed run has already been billed (no finally needed)', async () => {
    const sent: Array<{ calls: number; tokens: number }> = [];
    const b = new MeteredBudget(async (u) => void sent.push(u));
    b.record(400);
    b.record(600);
    // process dies here: no flush() ever called
    await new Promise((r) => setTimeout(r, 10));
    const calls = sent.reduce((n, u) => n + u.calls, 0);
    const tokens = sent.reduce((n, u) => n + u.tokens, 0);
    assert(calls === 2 && tokens === 1000, JSON.stringify(sent));
  });

  await testAsync('a failing recorder never throws into the run', async () => {
    const b = new MeteredBudget(async () => {
      throw new Error('db down');
    });
    b.record(10);
    await b.flush();
    assert.equal(b.snapshot().calls, 1);
  });
});

await suiteAsync('early persist', async () => {
  await testAsync('persisted, then the render throws: the user still gets the snapshot', async () => {
    // The route's contract with runDraftPipeline: onGenerated saves, a later step throws.
    let snapshotId: string | null = null;
    let generated: Parameters<typeof salvagedCompletePayload>[0] | null = null;
    const sent: Array<[string, Record<string, unknown>]> = [];

    const fakePipeline = async (onGenerated: (g: NonNullable<typeof generated>) => Promise<void>) => {
      await onGenerated({
        document: { sections: [] } as never,
        score: { overall: 8.6, passed: true } as never,
        job: null,
        fit: null,
        pdfName: 'Ada-Lovelace.pdf',
        docxName: 'Ada-Lovelace.docx',
      });
      throw new Error('render exploded');
    };

    try {
      await fakePipeline(async (g) => {
        generated = g;
        snapshotId = 'snap-saved';
      });
    } catch {
      if (snapshotId && generated) sent.push(['complete', salvagedCompletePayload(generated, snapshotId)]);
      else sent.push(['error', {}]);
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'complete');
    assert.equal(sent[0][1].snapshotId, 'snap-saved');
    const files = sent[0][1].fileNames as { pdf: string; docx: string };
    assert(files.pdf === 'Ada-Lovelace.pdf' && files.docx === 'Ada-Lovelace.docx');
    assert.equal((sent[0][1].selfTest as { pdfPassed: boolean }).pdfPassed, false, 'does not claim a passed check');
  });
});

await suiteAsync('stale draft-run reaper', async () => {
  await testAsync('reports counts, cuts at the cutoff, and is idempotent', async () => {
    const queries: string[] = [];
    // First pass: 3 saved, 2 unsaved. Second pass: nothing left.
    const answers = [[{ n: 3 }], [{ n: 2 }], [{ n: 0 }], [{ n: 0 }]];
    let pass = 0;
    const fake = {
      execute: async (q: unknown) => {
        queries.push(JSON.stringify(q));
        return answers[pass++ % answers.length];
      },
    };
    const now = new Date('2026-10-08T12:00:00.000Z');
    const r1 = await reapStaleDraftRuns(fake, { now });
    assert.deepEqual(r1, { failed: 2, succeeded: 3, more: false });
    const cutoff = '2026-10-08T11:45:00.000Z'; // 15 minutes before now
    assert(queries.every((q) => q.includes(cutoff)), 'cutoff is now minus 15 minutes');
    assert(queries[1].includes('timeout'), "unsaved runs are closed as error_kind 'timeout'");
    const r2 = await reapStaleDraftRuns(fake, { now });
    assert.deepEqual(r2, { failed: 0, succeeded: 0, more: false });
  });
});
