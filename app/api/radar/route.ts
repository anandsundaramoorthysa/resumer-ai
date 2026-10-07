/**
 * Job Radar, stepped like /api/sync: the client drives the loop, one short step per POST.
 * The logic lives in lib/radar/handlers.ts (injectable, so it is unit-tested); this file only
 * wires the real session, approval gate and orchestrator into it.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { assertBurst } from '@/lib/ai/daily-budget';
import { makeRadarHandlers } from '@/lib/radar/handlers';
import { advanceRadar, approveQueries, cancelRadar, getRadar, selectPosting, startRadar } from '@/lib/radar/runs';
import { creditStatus } from '@/lib/serp/budget';
import { approvalFor } from '@/lib/server/approval';
import { hasCurrentConsent } from '@/lib/legal/consent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// maxDuration is honoured on VERCEL only. On NETLIFY (free) a synchronous function is cut at
// ~26-30s regardless, so every radar step is built for that (see STEP_BUDGET_MS in lib/radar/runs.ts):
// each SerpApi http call is <= 8s and a step never waits on SerpApi for longer.
export const maxDuration = 60;

const authHost = () => {
  try {
    return process.env.AUTH_URL ? [new URL(process.env.AUTH_URL).host.toLowerCase()] : [];
  } catch {
    return [];
  }
};

const handlers = makeRadarHandlers({
  userId: async () => (await auth())?.user?.id ?? null,
  approval: approvalFor,
  consent: hasCurrentConsent,
  assertBurst: (userId) => assertBurst(userId),
  credits: creditStatus,
  get extraHosts() {
    return authHost();
  },
  start: (u, o) => startRadar(u, o),
  advance: (u, id, step) => advanceRadar(u, id, step),
  approve: (u, id, q) => approveQueries(u, id, q),
  select: (u, id, key) => selectPosting(u, id, key),
  cancel: (u, id) => cancelRadar(u, id),
  get: (u, id) => getRadar(u, id),
});

export const GET = (req: NextRequest) => handlers.GET(req);
export const POST = (req: NextRequest) => handlers.POST(req);
