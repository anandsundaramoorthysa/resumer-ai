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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
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
