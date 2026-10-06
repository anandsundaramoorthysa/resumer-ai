/**
 * Job Radar orchestrator, executed one short step per request (same shape as
 * lib/sync/stepped.ts).
 *
 *   plan -> [G1 queries] -> search:q0..qN -> rank -> intel:0..1 -> market -> [G2 select] -> done
 *
 * Each `advanceRadar` does one unit of work (one SerpApi search, one company, or one pure
 * step) and commits with `UPDATE ... WHERE step = expectStep`, so two tabs advancing the
 * same run cannot both win. One query or company failing is a 'warn' and a skip; only a
 * failed plan or every search failing is a hard error. Every message that can reach the
 * browser is authored here, never an upstream error string.
 */

import type { ContactInfo, ProfileRecord, RoleRecord } from '@/lib/types';
import type { DraftBudget } from '@/lib/ai/budget';
import { combineJobText } from '@/lib/intake/job-input';
import { companyIntel, searchJobs } from '@/lib/serp/client';
import { RUN_LIMITS, creditsAllowed, runAllowed } from '@/lib/serp/budget';
import type { EmployerIntel, MarketSignal, Plan, Posting, RankedPosting, SerpResult } from '@/lib/serp/types';
import {
  TERMINAL,
  appendEvents,
  boundPostings,
  emptyState,
  makeEvent,
  safeMessage,
} from './events';
import type { RadarEvent, RadarRunStatus, RadarStatus, RunState } from './events';

export type { RadarEvent, RadarStatus, RunState } from './events';

/* --------------------------------------------------------------------- store -- */

export interface Run {
  id: string;
  userId: string;
  status: RadarRunStatus;
  phase: string;
  step: number;
  totalSteps: number;
  message: string;
  state: RunState;
  events: RadarEvent[];
  creditsUsed: number;
  mode: 'live' | 'replay';
  error: string;
  createdAt: Date;
}

export type RunPatch = Partial<Omit<Run, 'id' | 'userId' | 'createdAt'>>;

export interface RunStore {
  insert(userId: string, init: Omit<Run, 'id' | 'userId' | 'createdAt'>): Promise<Run>;
  get(userId: string, id: string): Promise<Run | null>;
  latestActive(userId: string): Promise<Run | null>;
  countSince(userId: string, since: Date): Promise<number>;
  /** Atomic compare-and-set: applies `patch` only if step (and status, when given) still match. */
  update(id: string, where: { step: number; status?: RadarRunStatus[] }, patch: RunPatch): Promise<Run | null>;
}

export function memoryRunStore(): RunStore & { runs: Run[] } {
  const runs: Run[] = [];
  let n = 0;
  const copy = (r: Run): Run => structuredClone(r);
  return {
    runs,
    async insert(userId, init) {
      const run: Run = { ...structuredClone(init), id: `run-${++n}`, userId, createdAt: new Date() };
      runs.push(run);
      return copy(run);
    },
    async get(userId, id) {
      const r = runs.find((x) => x.id === id && x.userId === userId);
      return r ? copy(r) : null;
    },
    async latestActive(userId) {
      const r = runs.filter((x) => x.userId === userId && !TERMINAL.includes(x.status)).at(-1);
      return r ? copy(r) : null;
    },
    async countSince(userId, since) {
      return runs.filter((x) => x.userId === userId && x.createdAt >= since).length;
    },
    async update(id, where, patch) {
      const r = runs.find((x) => x.id === id);
      if (!r || r.step !== where.step || (where.status && !where.status.includes(r.status))) return null;
      Object.assign(r, structuredClone(patch));
      return copy(r);
    },
  };
}

export function drizzleRunStore(): RunStore {
  const load = async () => {
    const [{ db }, { agentRuns }, orm] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/db/schema-radar'),
      import('drizzle-orm'),
    ]);
    return { db, agentRuns, ...orm };
  };
  type Row = typeof import('@/lib/db/schema-radar').agentRuns.$inferSelect;
  const toRun = (r: Row): Run => ({
    id: r.id,
    userId: r.userId,
    status: r.status as RadarRunStatus,
    phase: r.phase,
    step: r.step,
    totalSteps: r.totalSteps,
    message: r.message,
    state: { ...emptyState(false), ...(r.state as Partial<RunState>) },
    events: r.events,
    creditsUsed: r.creditsUsed,
    mode: r.mode === 'replay' ? 'replay' : 'live',
    error: r.error,
    createdAt: r.createdAt,
  });
  return {
    async insert(userId, init) {
      const { db, agentRuns } = await load();
      const [row] = await db
        .insert(agentRuns)
        .values({ ...init, userId, state: init.state as unknown as Record<string, unknown> })
        .returning();
      return toRun(row);
    },
    async get(userId, id) {
      const { db, agentRuns, and, eq } = await load();
      const [row] = await db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, id), eq(agentRuns.userId, userId)))
        .limit(1);
      return row ? toRun(row) : null;
    },
    async latestActive(userId) {
      const { db, agentRuns, and, desc, eq, inArray } = await load();
      const [row] = await db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.userId, userId), inArray(agentRuns.status, ['running', 'awaiting'])))
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);
      return row ? toRun(row) : null;
    },
    async countSince(userId, since) {
      const { db, agentRuns, and, eq, gte, sql } = await load();
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(agentRuns)
        .where(and(eq(agentRuns.userId, userId), gte(agentRuns.createdAt, since)));
      return row?.n ?? 0;
    },
    async update(id, where, patch) {
      const { db, agentRuns, and, eq, inArray } = await load();
      const conds = [eq(agentRuns.id, id), eq(agentRuns.step, where.step)];
      if (where.status) conds.push(inArray(agentRuns.status, where.status));
      const [row] = await db
        .update(agentRuns)
        .set({ ...patch, state: patch.state as unknown as Record<string, unknown> | undefined, updatedAt: new Date() })
        .where(and(...conds))
        .returning();
      return row ? toRun(row) : null;
    },
  };
}

/* ---------------------------------------------------------------------- deps -- */

export interface Profile {
  records: ProfileRecord[];
  roles: RoleRecord[];
  contact: ContactInfo;
}

export interface RadarDeps {
  store: RunStore;
  now(): number;
  loadProfile(userId: string): Promise<Profile>;
  buildProfileDigest(records: ProfileRecord[], roles: RoleRecord[], contact: ContactInfo): string;
  planSearch(a: { digest: string; roles: RoleRecord[]; contact: ContactInfo; budget: DraftBudget }): Promise<Plan>;
  rankPostings(postings: Posting[], p: Profile, topK?: number): RankedPosting[];
  marketSignal(postings: Posting[], heldKeywords: string[]): MarketSignal;
  searchJobs(q: string, o: { userId: string; fromQuery: number }): Promise<SerpResult<Posting[]>>;
  companyIntel(company: string, serpJobId: string, userId: string): Promise<SerpResult<EmployerIntel>>;
  /** Daily AI allowance gate and recorder for the one planner call. */
  newBudget(): DraftBudget;
  aiAssert(userId: string): Promise<void>;
  aiRecord(userId: string, budget: DraftBudget): Promise<void>;
}

const defaultDeps: RadarDeps = {
  store: drizzleRunStore(),
  now: () => Date.now(),
  async loadProfile(userId) {
    const { loadProfileForUser } = await import('@/lib/server/profile');
    return loadProfileForUser(userId);
  },
  buildProfileDigest: (...a) => requireSync().buildProfileDigest(...a),
  planSearch: async (a) => (await import('./planner')).planSearch(a),
  rankPostings: (...a) => requireSync().rankPostings(...a),
  marketSignal: (...a) => requireSync().marketSignal(...a),
  searchJobs,
  companyIntel,
  newBudget: () => requireSync().newBudget(),
  async aiAssert(userId) {
    const { assertDailyBudget } = await import('@/lib/ai/daily-budget');
    await assertDailyBudget(userId);
  },
  async aiRecord(userId, budget) {
    const { recordDailyUsage } = await import('@/lib/ai/daily-budget');
    await recordDailyUsage(userId, budget.snapshot());
  },
};

// ponytail: the pure agents are loaded once at first use (top-level await would break
// test stubs that never touch them); preload() is called by the async entry points.
type Pure = {
  buildProfileDigest: RadarDeps['buildProfileDigest'];
  rankPostings: RadarDeps['rankPostings'];
  marketSignal: RadarDeps['marketSignal'];
  newBudget: () => DraftBudget;
};
let pure: Pure | null = null;
const requireSync = (): Pure => {
  if (!pure) throw new Error('Radar agents are not loaded.');
  return pure;
};
async function preload(d: RadarDeps): Promise<void> {
  if (d !== defaultDeps || pure) return;
  const [planner, ranker, market, budget] = await Promise.all([
    import('./planner'),
    import('./ranker'),
    import('./market'),
    import('@/lib/ai/budget'),
  ]);
  pure = {
    buildProfileDigest: planner.buildProfileDigest,
    rankPostings: ranker.rankPostings,
    marketSignal: market.marketSignal,
    // Fast and small: one planner call, a few seconds, nothing held back for rendering.
    newBudget: () => new budget.DraftBudget({ maxCalls: 3, maxTokens: 20_000 }, 6_500, 0),
  };
}

/* ------------------------------------------------------------------- helpers -- */

const INTEL_TOP = 2;
const QUERY_MAX_CHARS = 120;
const totalFor = (queries: number, intel: number) => 5 + queries + intel;

function toStatus(run: Run): RadarStatus {
  const s = run.state;
  return {
    runId: run.id,
    status: run.status,
    phase: run.phase,
    step: run.step,
    totalSteps: run.totalSteps,
    message: run.message,
    gate: run.status === 'awaiting' ? s.gate : '',
    events: run.events,
    // Descriptions are only needed server-side (selectPosting); keep polls light.
    state: { ...s, postings: s.postings.map((p) => ({ ...p, description: p.description.slice(0, 300) })) },
    creditsUsed: run.creditsUsed,
    mode: run.mode,
    error: run.error,
  };
}

const startOfDay = (now: number) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const skillNames = (records: ProfileRecord[]) =>
  records.flatMap((r) => (r.type === 'skill' ? [r.name] : []));

/* ---------------------------------------------------------------------- start -- */

export async function startRadar(
  userId: string,
  opts: { intel?: boolean } = {},
  d: RadarDeps = defaultDeps,
): Promise<RadarStatus> {
  const existing = await d.store.latestActive(userId);
  if (existing) return toStatus(existing);

  const today = await d.store.countSince(userId, startOfDay(d.now()));
  if (!runAllowed(today)) {
    throw new Error(
      `You have used today's ${RUN_LIMITS.runsPerDay} Job Radar runs. They reset at midnight UTC.`,
    );
  }
  const run = await d.store.insert(userId, {
    status: 'running',
    phase: 'plan',
    step: 0,
    totalSteps: totalFor(2, opts.intel === false ? 0 : INTEL_TOP),
    message: 'Planning your searches…',
    state: emptyState(opts.intel !== false),
    events: [makeEvent(d.now(), 'info', 'plan', 'Run started', 'radar')],
    creditsUsed: 0,
    mode: 'live',
    error: '',
  });
  return toStatus(run);
}

/* -------------------------------------------------------------------- advance -- */

type Work = RunPatch & { events?: RadarEvent[] };

export async function advanceRadar(
  userId: string,
  runId: string,
  expectStep: number,
  d: RadarDeps = defaultDeps,
): Promise<RadarStatus> {
  const run = await d.store.get(userId, runId);
  if (!run) throw new Error('That run was not found.');
  // Two tabs, a retry, a cancelled or finished run, or a run waiting on the user: no work.
  if (run.status !== 'running' || run.step !== expectStep) return toStatus(run);

  await preload(d);
  let work: Work;
  try {
    work = await runStep(run, d);
  } catch (err) {
    console.error('[radar] step failed for user', userId, 'phase', run.phase, err);
    const error = safeMessage(err, 'The radar stopped on our side. Try again in a minute.');
    work = {
      status: 'error',
      message: 'Radar failed',
      error,
      events: [makeEvent(d.now(), 'error', run.phase, error, 'radar')],
    };
  }

  const { events: add = [], ...patch } = work;
  const next = await d.store.update(
    run.id,
    { step: run.step, status: ['running'] },
    { ...patch, step: run.step + 1, events: appendEvents(run.events, add) },
  );
  // Lost the race to another tab: report whatever won.
  return toStatus(next ?? (await d.store.get(userId, runId)) ?? run);
}

async function runStep(run: Run, d: RadarDeps): Promise<Work> {
  const s = run.state;
  const ev = (level: RadarEvent['level'], message: string, source?: string) =>
    makeEvent(d.now(), level, run.phase, message, source);
  const [kind, idxRaw] = run.phase.split(':');
  const idx = Number(idxRaw?.replace(/^q/, ''));

  /* plan */
  if (kind === 'plan') {
    const profile = await d.loadProfile(run.userId);
    await d.aiAssert(run.userId);
    const budget = d.newBudget();
    let plan: Plan;
    try {
      plan = await d.planSearch({
        digest: d.buildProfileDigest(profile.records, profile.roles, profile.contact),
        roles: profile.roles,
        contact: profile.contact,
        budget,
      });
    } finally {
      await d.aiRecord(run.userId, budget);
    }
    const queries = plan.queries.slice(0, 3);
    if (queries.length === 0) {
      throw new Error('Add a role or skill to your profile first, so there is something to search for.');
    }
    return {
      status: 'awaiting',
      phase: 'awaiting-queries',
      message: 'Review the searches before they run',
      totalSteps: totalFor(queries.length, s.intelOn ? INTEL_TOP : 0),
      state: { ...s, plan, queries, gate: 'queries' },
      events: [ev('info', `Planned ${queries.length} search${queries.length > 1 ? 'es' : ''}`, 'planner')],
    };
  }

  /* search:q<i> */
  if (kind === 'search') {
    const q = s.queries[idx];
    const events: RadarEvent[] = [];
    let { creditsUsed, mode } = run;
    let postings = s.postings;
    let okQueries = s.okQueries;

    if (!creditsAllowed(creditsUsed, 1)) {
      events.push(ev('warn', `Skipped "${q.q}": this run's credit limit was reached`, 'serpapi:google_jobs'));
    } else {
      const r = await d.searchJobs(q.q, { userId: run.userId, fromQuery: idx });
      if (!r.ok) {
        events.push(ev('warn', `Search "${q.q}" failed (${r.reason}), skipped`, 'serpapi:google_jobs'));
      } else {
        okQueries += 1;
        creditsUsed += r.credits;
        const seen = new Set(postings.map((p) => p.key));
        const fresh = r.data.filter((p) => !seen.has(p.key) && seen.add(p.key));
        postings = boundPostings([...postings, ...fresh]);
        if (r.mode === 'replay' && mode !== 'replay') {
          mode = 'replay';
          events.push(ev('warn', 'Credits low, showing sample data', 'serpapi'));
        }
        events.push(
          ev(
            'info',
            `"${q.q}": ${r.data.length} postings, ${fresh.length} new${r.cached ? ' (cached)' : ''}`,
            'serpapi:google_jobs',
          ),
        );
      }
    }

    const last = idx + 1 >= s.queries.length;
    const state = { ...s, postings, okQueries };
    if (last && okQueries === 0) {
      throw new Error('Job search is unavailable right now. Nothing was spent beyond this run. Try again later.');
    }
    return {
      phase: last ? 'rank' : `search:q${idx + 1}`,
      message: last ? 'Ranking against your profile…' : `Searching: ${s.queries[idx + 1].q}`,
      state,
      creditsUsed,
      mode,
      events,
    };
  }

  /* rank */
  if (kind === 'rank') {
    const profile = await d.loadProfile(run.userId);
    const ranked = d.rankPostings(s.postings, profile, 5);
    const byKey = new Map(s.postings.map((p) => [p.key, p]));
    const targets: RunState['intelTargets'] = [];
    for (const r of ranked) {
      const p = byKey.get(r.key);
      if (p && !targets.some((t) => t.company === p.company)) targets.push({ company: p.company, serpJobId: p.serpJobId });
      if (targets.length >= INTEL_TOP) break;
    }
    const intelTargets = s.intelOn ? targets : [];
    return {
      phase: intelTargets.length ? 'intel:0' : 'market',
      message: intelTargets.length ? `Checking ${intelTargets[0].company}…` : 'Reading the market…',
      totalSteps: totalFor(s.queries.length, intelTargets.length),
      state: { ...s, ranked, intelTargets },
      events: [ev('info', `Ranked ${s.postings.length} postings, top ${ranked.length} kept`, 'ranker')],
    };
  }

  /* intel:<i> */
  if (kind === 'intel') {
    const t = s.intelTargets[idx];
    const events: RadarEvent[] = [];
    let { creditsUsed, mode } = run;
    let intel = s.intel;
    if (!creditsAllowed(creditsUsed, 2)) {
      events.push(ev('warn', `Skipped ${t.company}: this run's credit limit was reached`, 'serpapi:google_jobs_listing'));
    } else {
      const r = await d.companyIntel(t.company, t.serpJobId, run.userId);
      if (!r.ok) {
        events.push(ev('warn', `Could not look up ${t.company} (${r.reason}), skipped`, 'serpapi:google_news'));
      } else {
        creditsUsed += r.credits;
        intel = [...intel, r.data];
        if (r.mode === 'replay' && mode !== 'replay') {
          mode = 'replay';
          events.push(ev('warn', 'Credits low, showing sample data', 'serpapi'));
        }
        events.push(ev('info', `${t.company}: ${r.data.headlines.length} headlines`, 'serpapi:google_news'));
      }
    }
    const last = idx + 1 >= s.intelTargets.length;
    return {
      phase: last ? 'market' : `intel:${idx + 1}`,
      message: last ? 'Reading the market…' : `Checking ${s.intelTargets[idx + 1].company}…`,
      state: { ...s, intel },
      creditsUsed,
      mode,
      events,
    };
  }

  /* market */
  if (kind === 'market') {
    const profile = await d.loadProfile(run.userId);
    const market = d.marketSignal(s.postings, skillNames(profile.records));
    return {
      status: 'awaiting',
      phase: 'select',
      message: 'Pick a posting to tailor your resume to',
      state: { ...s, market, gate: 'select' },
      events: [ev('info', `Market signal from ${market.sampleSize} postings`, 'market')],
    };
  }

  throw new Error('This run is in a state that cannot continue.');
}

/* ---------------------------------------------------------------- gates, etc. -- */

async function gateUpdate(
  run: Run,
  patch: RunPatch,
  d: RadarDeps,
  add: RadarEvent[] = [],
): Promise<Run> {
  const next = await d.store.update(
    run.id,
    { step: run.step, status: ['awaiting'] },
    { ...patch, step: run.step + 1, events: appendEvents(run.events, add) },
  );
  return next ?? (await d.store.get(run.userId, run.id)) ?? run;
}

export async function approveQueries(
  userId: string,
  runId: string,
  queries: Array<string | { q: string; why?: string }>,
  d: RadarDeps = defaultDeps,
): Promise<RadarStatus> {
  const run = await d.store.get(userId, runId);
  if (!run) throw new Error('That run was not found.');
  if (run.status !== 'awaiting' || run.state.gate !== 'queries') return toStatus(run);

  const why = new Map(run.state.queries.map((x) => [x.q, x.why]));
  const seen = new Set<string>();
  const clean = queries
    .map((x) => (typeof x === 'string' ? { q: x, why: '' } : { q: x.q, why: x.why ?? '' }))
    .map((x) => ({ q: String(x.q).replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX_CHARS), why: x.why }))
    .filter((x) => x.q && !seen.has(x.q.toLowerCase()) && seen.add(x.q.toLowerCase()))
    .slice(0, 3)
    .map((x) => ({ q: x.q, why: why.get(x.q) ?? x.why.slice(0, 200) }));
  if (clean.length === 0) throw new Error('Keep at least one search to run.');

  const next = await gateUpdate(
    run,
    {
      status: 'running',
      phase: 'search:q0',
      message: `Searching: ${clean[0].q}`,
      totalSteps: totalFor(clean.length, run.state.intelOn ? INTEL_TOP : 0),
      state: { ...run.state, queries: clean, gate: '' },
    },
    d,
    [makeEvent(d.now(), 'info', 'awaiting-queries', `Approved ${clean.length} search${clean.length > 1 ? 'es' : ''}`, 'radar')],
  );
  return toStatus(next);
}

export function formatPosting(p: Posting): string {
  return [
    p.title,
    [p.company, p.location].filter(Boolean).join(' · '),
    p.highlights.length ? `\n${p.highlights.map((h) => `- ${h}`).join('\n')}` : '',
    `\n${p.description}`,
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export async function selectPosting(
  userId: string,
  runId: string,
  key: string,
  d: RadarDeps = defaultDeps,
): Promise<RadarStatus & { jobText: string }> {
  const run = await d.store.get(userId, runId);
  if (!run) throw new Error('That run was not found.');
  const posting = run.state.postings.find((p) => p.key === key);
  if (!posting) throw new Error('That posting is not part of this run.');
  const jobText = combineJobText(formatPosting(posting), '').text;

  if (run.status === 'awaiting' && run.state.gate === 'select') {
    const next = await gateUpdate(
      run,
      {
        status: 'done',
        phase: 'done',
        message: `Selected ${posting.title} at ${posting.company}`,
        state: { ...run.state, selectedKey: key, gate: '' },
      },
      d,
      [makeEvent(d.now(), 'info', 'select', `Selected ${posting.title} at ${posting.company}`, 'radar')],
    );
    return { ...toStatus(next), jobText };
  }
  // Already done (re-selecting to re-open the handoff) or still running: text only.
  return { ...toStatus(run), jobText };
}

export async function cancelRadar(userId: string, runId: string, d: RadarDeps = defaultDeps): Promise<RadarStatus> {
  const run = await d.store.get(userId, runId);
  if (!run) throw new Error('That run was not found.');
  if (TERMINAL.includes(run.status)) return toStatus(run);
  const next = await d.store.update(
    run.id,
    { step: run.step },
    {
      status: 'cancelled',
      message: 'Cancelled',
      step: run.step + 1,
      events: appendEvents(run.events, [makeEvent(d.now(), 'info', run.phase, 'Cancelled', 'radar')]),
    },
  );
  return toStatus(next ?? (await d.store.get(userId, runId)) ?? run);
}

export async function getRadar(userId: string, runId?: string, d: RadarDeps = defaultDeps): Promise<RadarStatus | null> {
  const run = runId ? await d.store.get(userId, runId) : await d.store.latestActive(userId);
  return run ? toStatus(run) : null;
}
