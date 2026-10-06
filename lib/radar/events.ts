/**
 * Job Radar run types and the append-only event log. Pure: no database, no network.
 * Everything here may reach the browser, so nothing in it may carry raw error text.
 */

import type { EmployerIntel, MarketSignal, Plan, Posting, RankedPosting } from '@/lib/serp/types';
import { authoredMessage } from '@/lib/server/user-message';

export const MAX_EVENTS = 60;
export const MAX_POSTINGS = 30;
export const MAX_DESCRIPTION_CHARS = 4_000;

export interface RadarEvent {
  at: string;
  level: 'info' | 'warn' | 'error';
  phase: string;
  message: string;
  source?: string;
}

export type RadarGate = 'queries' | 'select' | '';
export type RadarRunStatus = 'running' | 'awaiting' | 'done' | 'error' | 'cancelled';

/** Small by construction: postings are capped and their descriptions truncated. */
export interface RunState {
  /** Employer intel opted in (costs credits). */
  intelOn: boolean;
  gate: RadarGate;
  plan: Plan | null;
  /** The queries that will actually be searched (the plan's, as edited at G1). */
  queries: { q: string; why: string }[];
  postings: Posting[];
  okQueries: number;
  ranked: RankedPosting[];
  intelTargets: { company: string; serpJobId: string }[];
  intel: EmployerIntel[];
  market: MarketSignal | null;
  selectedKey: string;
}

export const emptyState = (intelOn: boolean): RunState => ({
  intelOn,
  gate: '',
  plan: null,
  queries: [],
  postings: [],
  okQueries: 0,
  ranked: [],
  intelTargets: [],
  intel: [],
  market: null,
  selectedKey: '',
});

export interface RadarStatus {
  runId: string;
  status: RadarRunStatus;
  phase: string;
  step: number;
  totalSteps: number;
  message: string;
  gate: RadarGate;
  events: RadarEvent[];
  state: RunState;
  creditsUsed: number;
  mode: 'live' | 'replay';
  error: string;
}

export const TERMINAL: RadarRunStatus[] = ['done', 'error', 'cancelled'];

/** Newest 60 only. Returns a new array. */
export function appendEvents(events: RadarEvent[], add: RadarEvent[]): RadarEvent[] {
  return [...events, ...add].slice(-MAX_EVENTS);
}

export const makeEvent = (
  now: number,
  level: RadarEvent['level'],
  phase: string,
  message: string,
  source?: string,
): RadarEvent => ({ at: new Date(now).toISOString(), level, phase, message, ...(source ? { source } : {}) });

/**
 * A sentence for the browser. Plain `Error`s are authored sentences, but one that smells
 * like a URL, a key, or a stack is replaced by the fallback regardless.
 */
export function safeMessage(err: unknown, fallback: string): string {
  const m = authoredMessage(err, fallback).slice(0, 300);
  return /https?:\/\/|api_key|apikey|secret|\bat .+:\d+/i.test(m) ? fallback : m;
}

/** Bound what is stored in jsonb. */
export function boundPostings(list: Posting[]): Posting[] {
  return list.slice(0, MAX_POSTINGS).map((p) =>
    p.description.length > MAX_DESCRIPTION_CHARS
      ? { ...p, description: p.description.slice(0, MAX_DESCRIPTION_CHARS) }
      : p,
  );
}
