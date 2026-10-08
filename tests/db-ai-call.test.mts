/**
 * ai_call attribution: rows carry user_id, draft_run_id and the right stage for each draft
 * stage, hold no prompt text, and leave with the account (export, then erasure).
 * The model is stubbed through setChainDeps; no provider is contacted.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { installTestDb } from './db/pg.mjs';
import { all, mkUser } from './db/seed.mjs';
import { setChainDeps, setTelemetrySink, setCooldownBackend, resetCooldownCache, resetBreakers } from '../lib/ai/chain';
import { DraftBudget } from '../lib/ai/budget';
import { MeteredBudget } from '../lib/pipeline/metered-budget';
import { openDraftRunId } from '../lib/pipeline/run';
import { generateInterviewPrep } from '../lib/generate/interview';
import { generateCoverLetter } from '../lib/generate/cover-letter';
import { draftSummary } from '../lib/generate/summary';
import { planSearch } from '../lib/radar/planner';
import { db } from '@/lib/db';
import { aiCall } from '../lib/db/schema-ai';
import { EXPORT_TABLES } from '../lib/legal/export-tables';
import type { JobRequirement, ResumeDocument } from '../lib/types';

const t = await installTestDb();
const { pg } = t;
process.env.GROQ_API_KEY = 'placeholder';
for (const k of ['FIREWORKS_API_KEY', 'TOGETHER_API_KEY', 'DEEPINFRA_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']) delete process.env[k];
setCooldownBackend(null);
resetCooldownCache();
resetBreakers();

const pending: Promise<unknown>[] = [];
setTelemetrySink((row) => {
  pending.push(db.insert(aiCall).values({ ...row, draftRunId: row.draftRunId ?? null, userId: row.userId ?? null }));
});
const flush = async () => { await Promise.all(pending.splice(0)); };

const SECRET = 'SECRET-PROMPT-TEXT-7f3a';
let reply = '{}';
setChainDeps({
  generateObject: (async () => ({ object: JSON.parse(reply), usage: { totalTokens: 10 }, finishReason: 'stop' })) as never,
  generateText: (async () => ({ text: reply, usage: { totalTokens: 10 }, finishReason: 'stop' })) as never,
  resolveModel: ((cfg: { id: string }) => ({ provider: cfg.id })) as never,
});

const doc = {
  id: 'd', userId: 'u',
  contact: { fullName: 'A Person', email: 'a@example.com', location: 'Chennai' },
  sections: [{ heading: 'Experience', items: [], groups: [{ title: 'Engineer', subtitle: 'Acme', dateRange: '2022', items: [{ text: `Cut latency 40% ${SECRET}` }] }] }],
} as unknown as ResumeDocument;
const job = { roleTitle: 'Engineer', company: 'Globex', seniority: 'mid', category: 'general', requiredSkills: [], preferredSkills: [], responsibilities: [], atsKeywords: [] } as unknown as JobRequirement;

const u = await mkUser(pg);
const other = await mkUser(pg);
await pg.query(`insert into draft_run (id, user_id, started_at, status) values ('run-1', $1, now(), 'running')`, [u]);

type Row = { stage: string; user_id: string | null; draft_run_id: string | null };
const rowsOf = (userId: string) => all<Row>(pg, `select stage, user_id, draft_run_id from ai_call where user_id=$1`, [userId]);

await suiteAsync('ai_call attribution', async () => {
  await testAsync('the run row is found for the user, and only theirs', async () => {
    process.env.DATABASE_URL = 'postgres://stub/stub'; // never opened: @/lib/db is the in-memory stub here
    assert.equal(await openDraftRunId(u), 'run-1');
    assert.equal(await openDraftRunId(other), null);
    delete process.env.DATABASE_URL;
  });

  await testAsync('each draft stage records user, run and its own stage', async () => {
    const budget = new MeteredBudget(async () => {}, undefined, undefined, undefined, u);
    budget.draftRunId = 'run-1';

    reply = JSON.stringify({ questions: [{ question: 'q', why: 'w', yourEvidence: '', category: 'technical' }] });
    await generateInterviewPrep(doc, job, budget);
    reply = JSON.stringify({ opening: 'o', body: ['b'], closing: 'c' });
    await generateCoverLetter(doc, job, budget);
    reply = JSON.stringify({ summary: 'An engineer.' });
    await draftSummary({ job, facts: 'Engineer at Acme', budget });
    reply = '{"nope":1}'; // fails the schema: the attempt is still recorded, under its stage
    await planSearch({ digest: 'Engineer', roles: [], contact: { fullName: 'A', email: 'a@example.com' } as never, budget });
    await flush();

    const rows = await rowsOf(u);
    for (const stage of ['interview', 'cover-letter', 'summary', 'planner']) {
      assert(rows.some((r) => r.stage === stage), `stage ${stage} in ${JSON.stringify(rows.map((r) => r.stage))}`);
    }
    assert(rows.every((r) => r.user_id === u && r.draft_run_id === 'run-1'), 'every row attributed');
    assert(!rows.some((r) => r.stage === 'unknown' || r.stage === 'unlabelled'));
  });

  await testAsync('a plain DraftBudget with a userId attributes too; no budget stays unattributed', async () => {
    const b = new DraftBudget();
    b.userId = other;
    reply = JSON.stringify({ summary: 'An engineer.' });
    await draftSummary({ job, facts: 'x', budget: b });
    await draftSummary({ job, facts: 'x' });
    await flush();
    const rows = await rowsOf(other);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].draft_run_id, null);
  });

  await testAsync('no prompt text is stored anywhere in the row', async () => {
    const raw = await all<Record<string, unknown>>(pg, `select * from ai_call`);
    assert(raw.length > 0);
    assert(!JSON.stringify(raw).includes(SECRET));
    assert(!JSON.stringify(raw).includes('Cut latency'));
  });

  await testAsync('every model call site in lib/ names its stage', async () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith(join('lib', 'ai', 'chain.ts'))) files.push(p);
      }
    };
    walk(join(process.cwd(), 'lib'));
    const missing = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /\bgenerate(Structured|PlainText)\(\{/.test(src) && !/stage:\s*'/.test(src);
    });
    assert.deepEqual(missing, []);
  });

  await testAsync('the user\'s ai_call rows are exported, then erased with the account', async () => {
    const spec = EXPORT_TABLES.find((x) => x.key === 'aiCalls')!;
    assert.equal(spec.userColumn, 'userId');
    const exported = await db.select().from(aiCall).where(eq(aiCall.userId, u));
    assert((await rowsOf(u)).length > 0 && exported.length === (await rowsOf(u)).length, 'rows are found by user_id');
    // The same statement app/settings/account/actions.ts runs inside deleteAccount.
    await db.transaction(async (tx) => {
      await tx.delete(aiCall).where(eq(aiCall.userId, u));
    });
    assert.equal((await rowsOf(u)).length, 0);
    assert.equal((await rowsOf(other)).length, 1, 'other users are untouched');
  });
});

await t.close();
