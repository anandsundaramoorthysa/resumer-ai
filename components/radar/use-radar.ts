'use client';

/**
 * Client loop for a Job Radar run. One request in flight at a time: while the run is
 * 'running' it POSTs an advance carrying `expectStep`; it pauses at 'awaiting' (a gate) and
 * stops at a terminal status. 429 backs off exponentially; any other failure stops the
 * loop and offers a retry. `demo` swaps the network for app/radar/demo-status.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RadarStatus } from '@/lib/radar/events';
// Client-safe copy: importing the value from lib/radar/events would pull server-only modules (DB driver) into the browser bundle.
const TERMINAL: readonly RadarStatus['status'][] = ['done', 'error', 'cancelled'];
import { DEMO_STEP_MS, demoAdvance, demoApprove, demoSelect, demoStart } from '@/app/radar/demo-status';

export interface Credits {
  left: number;
  hourUsed: number;
  mode: 'live' | 'replay';
}
export type Query = { q: string; why: string };

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function api<T>(method: 'GET' | 'POST', url: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof data?.error === 'string' ? data.error : 'Something went wrong. Try again.', res.status);
  return data as T;
}

const DEMO_CREDITS: Credits = { left: 92, hourUsed: 3, mode: 'replay' };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export function useRadar(demo: boolean) {
  const [run, setRun] = useState<RadarStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const ready = demo || loaded;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveCredits, setCredits] = useState<Credits | null>(null);
  const credits = demo ? DEMO_CREDITS : liveCredits;
  const [tick, setTick] = useState(0);
  const attempt = useRef(0);
  // Actions share one controller that is aborted on unmount.
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    life.current = ac;
    return () => ac.abort();
  }, []);

  // Resume after refresh.
  useEffect(() => {
    if (demo) return;
    const ac = new AbortController();
    api<{ run: RadarStatus | null }>('GET', '/api/radar', ac.signal)
      .then((d) => setRun(d.run && !TERMINAL.includes(d.run.status) ? d.run : null))
      .catch((e) => !aborted(e) && setError(e instanceof Error ? e.message : 'Could not load your run.'))
      .finally(() => !ac.signal.aborted && setLoaded(true));
    return () => ac.abort();
  }, [demo]);

  // Credit meter: refresh when the run changes state.
  const status = run?.status;
  useEffect(() => {
    if (demo) return;
    const ac = new AbortController();
    api<Credits>('GET', '/api/radar?credits=1', ac.signal)
      .then(setCredits)
      .catch(() => undefined);
    return () => ac.abort();
  }, [demo, status, run?.runId]);

  // The advance loop.
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const ac = new AbortController();
    (async () => {
      try {
        const next = demo
          ? (await sleep(DEMO_STEP_MS, ac.signal), demoAdvance(run))
          : await api<RadarStatus>('POST', '/api/radar', ac.signal, { runId: run.runId, expectStep: run.step });
        attempt.current = 0;
        setNotice('');
        if (next.step === run.step && next.status === 'running') await sleep(1000, ac.signal);
        setRun(next);
      } catch (e) {
        if (aborted(e)) return;
        if (e instanceof ApiError && e.status === 429) {
          const wait = Math.min(30_000, 2000 * 2 ** attempt.current++);
          setNotice(`The search service is busy. Retrying in ${Math.round(wait / 1000)} seconds. Your run is safe.`);
          try {
            await sleep(wait, ac.signal);
            setTick((t) => t + 1);
          } catch {
            /* unmounted */
          }
          return;
        }
        setError(e instanceof Error ? e.message : 'The run stopped unexpectedly.');
      }
    })();
    return () => ac.abort();
  }, [run, demo, tick]);

  const act = useCallback(
    async <T extends RadarStatus>(fn: (s: AbortSignal) => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError('');
      try {
        const next = await fn((life.current?.signal ?? new AbortController().signal));
        setRun(next);
        return next;
      } catch (e) {
        if (!aborted(e)) setError(e instanceof Error ? e.message : 'Something went wrong.');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const start = useCallback(
    (intel: boolean) =>
      act(async (s) => (demo ? demoStart(intel) : api<RadarStatus>('POST', '/api/radar', s, { intel }))),
    [act, demo],
  );
  const approve = useCallback(
    (queries: Query[]) =>
      act(async (s) =>
        demo && run
          ? demoApprove(run, queries)
          : api<RadarStatus>('POST', '/api/radar', s, { runId: run!.runId, action: 'approve', queries }),
      ),
    [act, demo, run],
  );
  const select = useCallback(
    (key: string) =>
      act(async (s) =>
        demo && run
          ? demoSelect(run, key)
          : api<RadarStatus & { jobText: string }>('POST', '/api/radar', s, { runId: run!.runId, action: 'select', key }),
      ) as Promise<(RadarStatus & { jobText: string }) | null>,
    [act, run, demo],
  );
  const cancel = useCallback(async () => {
    if (!run) return;
    if (demo) return setRun({ ...run, status: 'cancelled', message: 'Stopped' });
    await act((s) => api<RadarStatus>('POST', '/api/radar', s, { runId: run.runId, action: 'cancel' }));
  }, [act, run, demo]);
  const restart = useCallback(() => {
    setRun(null);
    setError('');
    setNotice('');
  }, []);
  /** Resume the loop after a non-429 failure. */
  const retry = useCallback(() => {
    setError('');
    setTick((t) => t + 1);
    setRun((r) => (r ? { ...r } : r));
  }, []);

  return { run, ready, error, notice, busy, credits, start, approve, select, cancel, restart, retry };
}
