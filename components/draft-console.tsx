'use client';

/**
 * The live pipeline panel — REQ-8.1.
 *
 * Every row here corresponds to a stage that is actually executing on the server. No
 * simulated progress, no fake timers: rows appear because an SSE event arrived. That
 * matters beyond honesty — the quality-gate rows are the product's whole argument for
 * why you should trust the output, so showing the real iteration scores IS the feature.
 *
 * A draft is now a short conversation rather than one long request:
 *
 *   1. fit check   (/api/draft/assess)       — reads the job, judges the fit, says why
 *   2. decision    — a good or near-good fit drafts straight away; a poor one asks first
 *   3. draft       (/api/draft)              — writes the resume from the checked job
 *   4. improve     (/api/draft/[id]/improve) — repeated while another pass can help
 *
 * Each step is its own request so each stays inside the host's 30-second limit, and the
 * user is never left watching a spinner with no idea whether the role was ever a fit.
 */

/*
 * Job Radar handoff. Radar writes these two sessionStorage keys, then navigates to the
 * page that renders this console; on mount the console reads and clears them:
 *
 *   radar:jobText   the job description text to pre-fill (skips scraping a URL)
 *   radar:jobLabel  short human label, e.g. "Platform Engineer at Acme", shown in a banner
 *
 * The same values can also be passed as the initialJobText / initialJobLabel props.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { KeywordHighlight } from '@/components/keyword-highlight';
import { ScoreStamp } from '@/components/score-stamp';
import {
  JOB_FILE_ACCEPT,
  MAX_JOB_FILE_BYTES,
  fileRejection,
  isAcceptedJobFile,
  validateJobSubmission,
} from '@/lib/intake/job-input';
import type { PipelineEvent, PipelineStage, QualityGateResult } from '@/lib/types';
import type { FitReport } from '@/lib/fit/agent';

const STAGE_LABELS: Record<PipelineStage, string> = {
  sync: 'Checking your portfolio',
  understand: 'Understanding the job',
  fit: 'Checking your fit for the role',
  retrieve: 'Finding your best-fit experience',
  draft: 'Drafting',
  score: 'Scoring against ATS criteria',
  finalize: 'Building your files',
};

const STAGE_ORDER: PipelineStage[] = [
  'sync',
  'understand',
  'fit',
  'retrieve',
  'draft',
  'score',
  'finalize',
];

/**
 * Improvement requests the browser will make for one resume.
 *
 * The server has its own, stricter stop — two passes that fail to move the score end the
 * loop, and eight scoring passes in total is the hard cap — so this is a backstop against
 * a client bug, not the policy.
 */
const MAX_IMPROVE_PASSES = 8;

const CUT_MESSAGE =
  'The connection closed before this step finished. This usually means it ran past the server’s time limit — trying again normally works.';

interface CompletePayload {
  snapshotId: string;
  score: QualityGateResult;
  selfTest: { pdfPassed: boolean; docxPassed: boolean; issues: string[] };
  fileNames: { pdf: string; docx: string };
  fit?: FitReport | null;
}

type Phase = 'idle' | 'assessing' | 'deciding' | 'drafting' | 'improving' | 'done';

interface PassRecord {
  pass: number;
  overall: number;
  improved: boolean;
}

/** What came of a "I do have that" sentence — what was saved, and what was refused. */
interface AmendResult {
  added: string | null;
  dropped: string[];
  unplaced: string[];
  message: string | null;
}

/** Short enough to be a sentence, long enough to name a skill and where it was used. */
const MIN_AMEND_CHARS = 10;

/**
 * Reads an event stream until it ends. Returns whether the server said how it ended.
 *
 * A stream that closes without a terminal event is not a finished step — it is a server
 * that stopped talking, which on a serverless host almost always means the platform
 * killed the function at its time limit. Treating that close as success is how the
 * progress list once froze on a running step with no result and no error.
 */
async function readEvents(
  res: Response,
  on: (name: string, payload: unknown) => void,
): Promise<boolean> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      // Heartbeat comments carry no data line and are skipped here.
      if (!dataLine) continue;

      const name = eventLine?.slice(7).trim() ?? 'message';
      if (name === 'complete' || name === 'error' || name === 'assessed') ended = true;
      on(name, JSON.parse(dataLine.slice(6)));
    }
  }

  return ended;
}

const RADAR_TEXT_KEY = 'radar:jobText';
const RADAR_LABEL_KEY = 'radar:jobLabel';

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function DraftConsole({
  initialJobText,
  initialJobLabel,
}: {
  initialJobText?: string;
  initialJobLabel?: string;
} = {}) {
  const [jobInput, setJobInput] = useState(initialJobText ?? '');
  const [radarLabel, setRadarLabel] = useState<string | null>(
    initialJobText ? (initialJobLabel ?? 'selected job') : null,
  );
  const [elapsed, setElapsed] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState<FitReport | null>(null);
  const [declined, setDeclined] = useState(false);
  const [result, setResult] = useState<CompletePayload | null>(null);
  const [passes, setPasses] = useState<PassRecord[]>([]);
  const [amendPending, setAmendPending] = useState(false);
  const [amendResult, setAmendResult] = useState<AmendResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tokenRef = useRef<string | null>(null);
  const stopRef = useRef(false);
  const startedAtRef = useRef(0);

  const busy = phase === 'assessing' || phase === 'drafting' || phase === 'improving';

  // Radar handoff (see top of file). Read once, then clear so a refresh starts clean.
  useEffect(() => {
    try {
      const text = sessionStorage.getItem(RADAR_TEXT_KEY);
      const label = sessionStorage.getItem(RADAR_LABEL_KEY);
      sessionStorage.removeItem(RADAR_TEXT_KEY);
      sessionStorage.removeItem(RADAR_LABEL_KEY);
      if (text) {
        // Reading sessionStorage must wait for mount (SSR has none), hence setState here.
        /* eslint-disable react-hooks/set-state-in-effect */
        setJobInput(text);
        setRadarLabel(label || 'selected job');
        /* eslint-enable react-hooks/set-state-in-effect */
      }
    } catch {
      // Storage can be blocked; the console then simply starts empty.
    }
  }, []);

  // Elapsed timer for the progress line; real clock, restarts per run.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  /**
   * Type and size are checked here purely so the answer is instant; the server checks
   * both again, on the bytes it actually received, and is the one that decides.
   */
  const chooseFile = useCallback((picked: File) => {
    if (!isAcceptedJobFile(picked.name, picked.type)) {
      setError(fileRejection('file-type').message);
      return;
    }
    if (picked.size === 0) {
      setError(fileRejection('file-empty').message);
      return;
    }
    if (picked.size > MAX_JOB_FILE_BYTES) {
      setError(
        fileRejection('file-too-big', {
          sizeBytes: picked.size,
          maxBytes: MAX_JOB_FILE_BYTES,
        }).message,
      );
      return;
    }
    setError(null);
    setFile(picked);
  }, []);

  /** POSTs and reads the stream. 'failed' means the server refused before streaming. */
  const postStream = useCallback(
    async (
      url: string,
      init: RequestInit,
      on: (name: string, payload: unknown) => void,
    ): Promise<'ended' | 'cut' | 'failed'> => {
      const controller = new AbortController();
      abortRef.current = controller;
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? 'That request failed.');
        return 'failed';
      }
      return (await readEvents(res, on)) ? 'ended' : 'cut';
    },
    [],
  );

  const onStage = useCallback((payload: unknown) => {
    setEvents((prev) => [...prev, payload as PipelineEvent]);
  }, []);

  /* ------------------------------------------------------------ improve --- */

  const improve = useCallback(
    async (snapshotId: string) => {
      setPhase('improving');
      try {
        for (let pass = 1; pass <= MAX_IMPROVE_PASSES; pass++) {
          if (stopRef.current) break;

          const box: { score?: QualityGateResult; improved: boolean; failed: boolean } = {
            improved: false,
            failed: false,
          };
          const outcome = await postStream(
            `/api/draft/${snapshotId}/improve`,
            { method: 'POST' },
            (name, payload) => {
              if (name === 'stage') onStage(payload);
              else if (name === 'complete') {
                const p = payload as { score: QualityGateResult; improved: boolean };
                box.score = p.score;
                box.improved = p.improved;
              } else if (name === 'error') {
                box.failed = true;
                setError((payload as { message?: string }).message ?? 'Improving stopped.');
              }
            },
          );

          if (outcome === 'cut') setError(CUT_MESSAGE);
          if (outcome !== 'ended' || box.failed || !box.score) break;

          const score = box.score;
          setPasses((prev) => [...prev, { pass, overall: score.overall, improved: box.improved }]);
          setResult((prev) => (prev ? { ...prev, score } : prev));
          if (score.passed || !score.loop?.canContinue) break;
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError((err as Error).message);
      } finally {
        setPhase('done');
      }
    },
    [onStage, postStream],
  );

  /* -------------------------------------------------------------- draft --- */

  const draft = useCallback(
    async (token: string) => {
      setPhase('drafting');
      const box: { result?: CompletePayload } = {};
      try {
        const outcome = await postStream(
          '/api/draft',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assessment: token }),
          },
          (name, payload) => {
            if (name === 'stage') onStage(payload);
            else if (name === 'complete') box.result = payload as CompletePayload;
            else if (name === 'error') {
              setError((payload as { message?: string }).message ?? 'Draft failed.');
            }
          },
        );
        if (outcome === 'cut') setError(CUT_MESSAGE);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError((err as Error).message);
      }

      const drafted = box.result;
      if (!drafted) {
        setPhase('done');
        return;
      }
      setResult(drafted);
      if (!drafted.score.passed && drafted.score.loop?.canContinue && !stopRef.current) {
        await improve(drafted.snapshotId);
      } else {
        setPhase('done');
      }
    },
    [improve, onStage, postStream],
  );

  /* -------------------------------------------------------------- start --- */

  const start = useCallback(async () => {
    if (busy) return;

    // The floor cannot be judged on the file's text from here — the browser has not
    // read it — so an attachment counts as "enough" and the server, which has the
    // extracted text, applies the real three-character rule.
    const rejection = validateJobSubmission(jobInput, file ? 3 : 0);
    if (rejection) {
      setError(rejection.message);
      return;
    }

    setEvents([]);
    setError(null);
    setFit(null);
    setDeclined(false);
    setResult(null);
    setPasses([]);
    setAmendResult(null);
    stopRef.current = false;
    tokenRef.current = null;
    startedAtRef.current = Date.now();
    setElapsed(0);
    setPhase('assessing');

    // Multipart only when there is a file to carry. Without one the request is plain
    // JSON, so nothing about the text-only path changes.
    let init: RequestInit;
    if (file) {
      const form = new FormData();
      form.append('jobInput', jobInput);
      form.append('jobFile', file);
      init = { method: 'POST', body: form };
    } else {
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobInput }),
      };
    }

    const box: { token?: string; fit?: FitReport } = {};
    // One silent retry when the connection drops before the verdict arrives. The fit
    // check writes nothing, so running it again is safe — and a reset mid-stream at the
    // host's edge was seen in end-to-end runs, surfacing as a bare "network error".
    for (let attempt = 1; attempt <= 2 && !box.token; attempt++) {
      if (attempt > 1) setEvents([]);
      try {
        const outcome = await postStream('/api/draft/assess', init, (name, payload) => {
          if (name === 'stage') onStage(payload);
          else if (name === 'assessed') {
            const p = payload as { token: string; fit: FitReport };
            box.token = p.token;
            box.fit = p.fit;
          } else if (name === 'error') {
            setError((payload as { message?: string }).message ?? 'The fit check failed.');
          }
        });
        if (outcome !== 'cut') break;
        if (attempt === 2) setError(CUT_MESSAGE);
      } catch (err) {
        if ((err as Error).name === 'AbortError') break;
        if (attempt === 2) setError('The connection dropped during the fit check. Please try again.');
      }
    }

    if (!box.token || !box.fit) {
      setPhase('done');
      return;
    }

    tokenRef.current = box.token;
    setFit(box.fit);
    if (box.fit.decision === 'proceed') await draft(box.token);
    else setPhase('deciding');
  }, [busy, draft, file, jobInput, onStage, postStream]);

  /**
   * "I do have that, my profile just never said so."
   *
   * The sentence goes to the profile through the same validation the resume importer
   * uses, and the fit is then judged again on the profile as it now stands. If that
   * clears the bar the draft starts by itself — the user has already said what they
   * wanted, and asking them a second time for the same answer is a click for nothing.
   */
  const amend = useCallback(
    async (text: string) => {
      const token = tokenRef.current;
      if (!token) return;

      setAmendPending(true);
      setError(null);
      try {
        const res = await fetch('/api/draft/assess/amend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assessment: token, text }),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
          added?: string | null;
          dropped?: string[];
          unplaced?: string[];
          message?: string;
          fit?: FitReport;
          token?: string;
        };

        if (!res.ok) {
          setError(payload.error ?? 'That could not be saved.');
          return;
        }

        setAmendResult({
          added: payload.added ?? null,
          dropped: payload.dropped ?? [],
          unplaced: payload.unplaced ?? [],
          message: payload.message ?? null,
        });

        if (payload.fit && payload.token) {
          tokenRef.current = payload.token;
          setFit(payload.fit);
          if (payload.fit.decision === 'proceed') {
            startedAtRef.current = Date.now();
            setElapsed(0);
            await draft(payload.token);
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError((err as Error).message);
      } finally {
        setAmendPending(false);
      }
    },
    [draft],
  );

  const draftAnyway = useCallback(() => {
    if (!tokenRef.current) return;
    startedAtRef.current = Date.now();
    setElapsed(0);
    void draft(tokenRef.current);
  }, [draft]);

  /**
   * Retry keeps the input exactly as it was. If the fit check already succeeded, only the
   * draft is re-run from the same sealed token; otherwise the whole run restarts.
   */
  const retry = useCallback(() => {
    setError(null);
    if (tokenRef.current && fit) draftAnyway();
    else void start();
  }, [draftAnyway, fit, start]);

  const decline = useCallback(() => {
    setDeclined(true);
    setPhase('done');
  }, []);

  const stop = useCallback(() => {
    stopRef.current = true;
    abortRef.current?.abort();
  }, []);

  /* ------------------------------------------------------------- render --- */

  const latestByStage = new Map<PipelineStage, PipelineEvent>();
  const scoreRows: PipelineEvent[] = [];
  for (const e of events) {
    if (e.stage === 'score' && e.status === 'running') scoreRows.push(e);
    else latestByStage.set(e.stage, e);
  }
  const startedStages = STAGE_ORDER.filter(
    (s) => latestByStage.has(s) || (s === 'score' && scoreRows.length > 0),
  );

  // Shown the moment the button is pressed, before the server has said anything.
  const totalSteps = STAGE_ORDER.length;
  const currentStep = Math.min(Math.max(startedStages.length, 1), totalSteps);
  const currentStage = startedStages[startedStages.length - 1];
  const stepText =
    phase === 'improving'
      ? 'Improving the draft'
      : currentStage
        ? STAGE_LABELS[currentStage]
        : phase === 'drafting'
          ? 'Starting the draft'
          : 'Starting the fit check';
  const showProgress = busy || startedStages.length > 0;
  const failed = !!error && !busy && !result && !declined;

  const buttonLabel =
    phase === 'assessing'
      ? 'Checking fit…'
      : phase === 'drafting'
        ? 'Drafting…'
        : phase === 'improving'
          ? 'Improving…'
          : 'Draft resume →';

  return (
    <div className="space-y-4">
      <div className="sheet p-4 sm:p-5">
        <h2 className="font-display text-xl">Start a new resume</h2>
        <p className="mt-1 text-sm text-muted">
          Paste a job link, a full description, or a LinkedIn post — or attach the job
          description as a PDF or DOCX. Either one on its own is enough, and you can do
          both. We check how well your profile fits the role first, and tell you why.
        </p>

        {radarLabel && (
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border border-line bg-paper px-3 py-2 text-sm">
            <span>
              Job from Radar: <span className="font-semibold">{radarLabel}</span>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRadarLabel(null);
                setJobInput('');
                document.getElementById('jobInput')?.focus();
              }}
              className="min-h-6 font-semibold underline disabled:opacity-50"
            >
              change
            </button>
          </p>
        )}

        <label htmlFor="jobInput" className="sr-only">
          Job posting link or description
        </label>
        <textarea
          id="jobInput"
          value={jobInput}
          onChange={(e) => setJobInput(e.target.value)}
          placeholder="Paste a job URL, description, or LinkedIn post here…"
          rows={5}
          disabled={busy}
          className="field mt-4 resize-y disabled:opacity-60"
        />

        <div className="mt-3 border border-dashed border-line p-3">
          {file ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 break-all font-mono text-xs text-ink">
                {file.name}
                <span className="text-muted"> · {(file.size / 1024).toFixed(0)} KB</span>
              </span>
              <button
                type="button"
                onClick={() => setFile(null)}
                disabled={busy}
                className="btn ml-auto"
              >
                Remove file
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              {/* The input is hidden from sight but not from the keyboard: the label is
                  the 44px target, and focus lands on it through the association. */}
              <label htmlFor="jobFile" className="btn focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue">
                Attach a PDF or DOCX
                <input
                  id="jobFile"
                  type="file"
                  accept={JOB_FILE_ACCEPT}
                  disabled={busy}
                  className="sr-only"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    if (picked) chooseFile(picked);
                    e.target.value = '';
                  }}
                />
              </label>
              <span className="text-xs text-muted">
                Optional. Read in memory and never stored — a scan or a photo has no text
                layer and cannot be read.
              </span>
            </div>
          )}
        </div>

        {/* Anything raised before the first stage appears belongs beside the controls
            that caused it; once stages are on screen the failure is shown against them. */}
        {error && !showProgress && (
          <ErrorBox message={error} onRetry={failed ? retry : undefined} />
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {/*
            The disclosure belongs where the decision is made, not only in settings.
            This is the button that sends someone's name, employers and history to a
            third-party AI company, and until now nothing on the way to it said so or
            named one.
          */}
          <span className="max-w-prose text-xs text-muted">
            Your portfolio is re-checked for changes before drafting. This sends your
            profile and the job description to a third-party AI provider —{' '}
            <a
              href="/settings/application#where-your-data-goes"
              className="font-semibold text-ink underline"
            >
              which ones, and what is sent
            </a>
            .
          </span>
          <button
            type="button"
            onClick={start}
            disabled={busy || (!file && jobInput.trim().length < 3)}
            className="btn btn-primary"
          >
            {busy && <Spinner />}
            {buttonLabel}
          </button>
        </div>
      </div>

      {showProgress && (
        <div className="sheet p-4 sm:p-5">
          <h3 className="eyebrow">Live progress</h3>

          {/* Plain text, not a live region: a ticking clock would be read out every second.
              The stage list below is the polite announcement. */}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            {busy && <Spinner />}
            <span className="font-semibold tabular-nums">
              Step {currentStep} of {totalSteps} · {formatElapsed(elapsed)}
            </span>
            <span className="text-muted">{stepText}{busy ? '…' : ''}</span>
          </div>
          <div
            className="progress mt-2"
            role="progressbar"
            aria-label="Draft progress"
            aria-valuemin={0}
            aria-valuemax={totalSteps}
            aria-valuenow={busy ? currentStep - 1 : startedStages.length}
            aria-valuetext={`Step ${currentStep} of ${totalSteps}`}
          >
            <span
              style={{
                width: `${(((busy ? currentStep - 1 : startedStages.length) / totalSteps) * 100).toFixed(0)}%`,
              }}
            />
          </div>

          {/* REQ-8.1 is a live view, and "live" has to mean live for a screen reader
              too — polite so each stage is announced without interrupting. */}
          <ol className="mt-4 space-y-0" aria-live="polite" aria-busy={busy}>
            {startedStages.map((stage) => {
              const event = latestByStage.get(stage);
              const isScore = stage === 'score';
              const status = event?.status ?? 'running';

              return (
                <li key={stage} className="border-b border-line py-3 last:border-b-0">
                  <div className="flex items-start gap-3">
                    <StatusDot status={status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {STAGE_LABELS[stage]}
                        <span className="sr-only"> — {STATUS_WORDS[status]}</span>
                      </div>

                      {isScore && scoreRows.length > 0 && (
                        <ul className="mt-1.5 space-y-1">
                          {scoreRows.map((row, i) => (
                            <li key={i} className="font-mono text-xs text-muted tabular">
                              {row.message}
                            </li>
                          ))}
                        </ul>
                      )}

                      {event?.message && (
                        <div
                          className={`mt-1 text-xs ${
                            status === 'error' ? 'text-danger' : 'text-muted'
                          }`}
                        >
                          {event.message}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          {error && <ErrorBox message={error} onRetry={failed ? retry : undefined} />}
        </div>
      )}

      {fit && (
        <FitCard
          fit={fit}
          deciding={phase === 'deciding'}
          declined={declined}
          autoProceeded={fit.decision === 'proceed'}
          onYes={draftAnyway}
          onNo={decline}
          onAmend={amend}
          amendPending={amendPending}
          amendResult={amendResult}
        />
      )}

      {result && (
        <ResultCard result={result} improving={phase === 'improving'} passes={passes} onStop={stop} />
      )}
    </div>
  );
}

const STATUS_WORDS: Record<'running' | 'done' | 'error', string> = {
  running: 'in progress',
  done: 'done',
  error: 'failed',
};

/** Spinner that stands still for people who asked for reduced motion. */
function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-4 w-4 flex-none animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 bg-danger-tint px-3 py-2.5 text-sm text-danger">
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn border-danger bg-surface text-danger">
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * The mark is decorative: the same status is spelled out in the sr-only text beside the
 * stage name, so nothing here is carried by shape or colour alone (WCAG 1.4.1).
 */
function StatusDot({ status }: { status: 'running' | 'done' | 'error' }) {
  const base = 'mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full text-xs';
  if (status === 'done')
    return <span aria-hidden className={`${base} bg-success-tint text-success`}>✓</span>;
  if (status === 'error')
    return <span aria-hidden className={`${base} bg-danger-tint text-danger`}>!</span>;
  return (
    <span aria-hidden className={`${base} bg-brand-tint text-brand-dark`}>
      <span className="font-mono">·</span>
    </span>
  );
}

/* ---------------------------------------------------------------- fit card -- */

const VERDICT_LABEL: Record<FitReport['verdict'], string> = {
  strong: 'Strong match',
  good: 'Good match',
  partial: 'Partial match',
  weak: 'Not a match yet',
};

const FACET_MARK: Record<FitReport['facets'][number]['status'], { mark: string; word: string; tone: string }> = {
  meets: { mark: '✓', word: 'meets', tone: 'bg-success-tint text-success' },
  partial: { mark: '~', word: 'partly meets', tone: 'bg-warning-tint text-warning' },
  missing: { mark: '✕', word: 'missing', tone: 'bg-danger-tint text-danger' },
  unclear: { mark: '?', word: 'not shown either way', tone: 'bg-paper text-muted' },
};

const AREA_LABEL: Record<FitReport['facets'][number]['area'], string> = {
  skills: 'Skills',
  experience: 'Experience',
  education: 'Education',
  eligibility: 'Eligibility',
  domain: 'Domain',
  location: 'Location',
  other: 'Other',
};

function FitCard({
  fit,
  deciding,
  declined,
  autoProceeded,
  onYes,
  onNo,
  onAmend,
  amendPending,
  amendResult,
}: {
  fit: FitReport;
  deciding: boolean;
  declined: boolean;
  autoProceeded: boolean;
  onYes: () => void;
  onNo: () => void;
  onAmend: (text: string) => void;
  amendPending: boolean;
  amendResult: AmendResult | null;
}) {
  const good = fit.verdict === 'strong' || fit.verdict === 'good';
  const badge = good
    ? 'bg-success-tint text-success'
    : fit.verdict === 'partial'
      ? 'bg-warning-tint text-warning'
      : 'bg-danger-tint text-danger';
  const held = fit.skills.held.map((s) => s.keyword);

  return (
    <section aria-labelledby="fit-heading" className="sheet p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Role fit · assessed as {fit.persona}</p>
          <h3 id="fit-heading" className="mt-1 font-display text-xl">
            {fit.headline}
          </h3>
        </div>
        <span className={`px-3 py-1 font-mono text-xs font-semibold tabular ${badge}`}>
          {VERDICT_LABEL[fit.verdict]} · {fit.score}/100
        </span>
      </div>

      {/* The decision comes first: it is the one thing on this card that needs an answer. */}
      {autoProceeded && (
        <p className="mt-4 bg-success-tint px-3 py-2.5 text-sm text-success">
          That’s a workable fit, so drafting started straight away.
        </p>
      )}

      {deciding && (
        <div className="mt-4 border border-rule p-4">
          <p className="text-sm font-semibold">
            This looks like a stretch for your profile as it stands. Draft it anyway?
          </p>
          <p className="mt-1 text-xs text-muted">
            The draft only uses what your profile says — nothing is invented to close the
            gap — so expect a lower score. You can also add what’s missing below first.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" onClick={onYes} className="btn btn-primary">
              Yes, draft it
            </button>
            <button type="button" onClick={onNo} className="btn">
              No, stop here
            </button>
          </div>
        </div>
      )}

      {declined && (
        <p className="mt-4 bg-paper px-3 py-2.5 text-sm text-muted">
          No resume was drafted, and nothing about this check was saved.
        </p>
      )}

      <p className="mt-4 text-sm">
        <KeywordHighlight text={fit.summary} matched={held} missing={fit.skills.missing} />
      </p>

      {fit.knockouts.length > 0 && (
        <div className="mt-4 bg-danger-tint px-3 py-2.5 text-sm text-danger">
          <p className="font-semibold">Eligibility rules your profile does not meet</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {fit.knockouts.map((k, i) => (
              <li key={i}>
                <span className="font-medium">“{k.requirement}”</span> — {k.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(fit.skills.held.length > 0 || fit.skills.missing.length > 0) && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-muted">
              Asked for, and in your profile ({fit.skills.held.length})
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {fit.skills.held.map((s) => (
                <li
                  key={s.keyword}
                  title={s.evidence ? `Shown by: ${s.evidence}` : undefined}
                  className="text-sm"
                >
                  <KeywordHighlight text={s.keyword} matched={[s.keyword]} />
                </li>
              ))}
              {fit.skills.held.length === 0 && <li className="text-xs text-muted">None</li>}
            </ul>
          </div>
          <div>
            {/* "Not named", because this list is the keyword matcher's: it knows whether
                a term is written in the profile, not whether related work implies it.
                The requirement-by-requirement review below is where that is judged. */}
            <p className="text-xs font-semibold text-muted">
              Asked for, not named in your profile ({fit.skills.missing.length})
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
              {fit.skills.missing.map((s) => (
                <li key={s} className="text-sm">
                  <KeywordHighlight text={s} matched={[]} missing={[s]} />
                </li>
              ))}
              {fit.skills.missing.length === 0 && <li className="text-xs text-muted">None</li>}
            </ul>
          </div>
        </div>
      )}

      {fit.facets.length > 0 && (
        <details className="mt-4 group" open={!good}>
          <summary className="cursor-pointer text-sm font-semibold">
            Requirement by requirement
          </summary>
          <ul className="mt-2 space-y-2">
            {fit.facets.map((f, i) => {
              const m = FACET_MARK[f.status];
              return (
                <li key={i} className="flex items-start gap-2.5 text-sm">
                  <span
                    aria-hidden
                    className={`mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full text-xs ${m.tone}`}
                  >
                    {m.mark}
                  </span>
                  <div className="min-w-0">
                    <p>
                      <span className="font-mono text-xs uppercase text-muted">
                        {AREA_LABEL[f.area]}
                      </span>{' '}
                      {f.requirement}
                      <span className="sr-only"> — {m.word}</span>
                    </p>
                    {f.note && <p className="text-xs text-muted">{f.note}</p>}
                    {f.evidence.length > 0 && (
                      <p className="text-xs text-muted">
                        Shown by: {f.evidence.map((e) => e.label).join(' · ')}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {fit.nextSteps.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-semibold">What would strengthen your case</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {fit.nextSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {fit.source === 'rules' && (
        <p className="mt-3 text-xs text-muted">
          The detailed review was unavailable just now, so this verdict is based on a
          skills and experience comparison alone — eligibility rules were not checked.
        </p>
      )}

      {/*
        The list above is what the profile does not SAY. For a real person a good part of
        it is not a gap at all — they have done the thing and never wrote it down, and
        until now the only way to fix that was to leave this page, find the right editor,
        and type the fact into the right shape. Most people would draft a worse resume
        instead. So: say it here, in a sentence.
      */}
      {(deciding || amendResult) && (
        <AmendBox
          missing={fit.skills.missing}
          pending={amendPending}
          result={amendResult}
          onSubmit={onAmend}
        />
      )}
    </section>
  );
}

/**
 * Saying what the profile left out, and having it saved properly.
 *
 * Deliberately one plain box rather than a form per record type. The point is that
 * someone looking at "SQL — not named in your profile" can answer in the words they
 * would use out loud; routing that into a skill, a project or a role is the server's
 * job (lib/profile/claim.ts), and it will refuse anything the sentence does not support.
 *
 * What is refused is shown, not hidden. If the reading dropped half of what was written,
 * the person needs to know that before they believe their profile now says it.
 */
function AmendBox({
  missing,
  pending,
  result,
  onSubmit,
}: {
  missing: string[];
  pending: boolean;
  result: AmendResult | null;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const example = missing[0] ?? 'SEO';

  return (
    <div className="mt-4 border border-line p-4">
      <p className="text-sm font-semibold">Is something here missing only because your profile never said it?</p>
      <p className="mt-1 text-xs text-muted">
        If you have done any of the underlined items, tell us in your own words and it
        will be saved to your profile — then this role is checked again. Only what you
        write is saved; nothing is filled in for you.
      </p>

      <label htmlFor="amend" className="sr-only">
        What you have done that your profile does not mention
      </label>
      <textarea
        id="amend"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        disabled={pending}
        placeholder={`e.g. I've done ${example} on all my own products and for ferventers.com — mostly technical audits.`}
        className="field mt-3 resize-y disabled:opacity-60"
      />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            onSubmit(text);
            setText('');
          }}
          disabled={pending || text.trim().length < MIN_AMEND_CHARS}
          className="btn btn-primary"
        >
          {pending ? 'Saving and re-checking…' : 'Save and check again'}
        </button>
        <span className="text-xs text-muted">
          Saved to your profile, so every future resume can use it.
        </span>
      </div>

      {result && (
        <div className="mt-3 space-y-2 text-sm" aria-live="polite">
          {result.added && (
            <p className="bg-success-tint px-3 py-2 text-success">{result.added}</p>
          )}
          {result.message && !result.added && (
            <p className="bg-paper px-3 py-2 text-muted">{result.message}</p>
          )}
          {result.dropped.length > 0 && (
            <div className="bg-warning-tint px-3 py-2 text-warning">
              <p className="font-semibold">Not saved, because your note didn’t say it:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.dropped.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {result.unplaced.length > 0 && (
            <div className="bg-paper px-3 py-2 text-muted">
              <p className="font-semibold">Couldn’t place this part of what you wrote:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.unplaced.map((u, i) => (
                  <li key={i}>“{u}”</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- result card -- */

function ResultCard({
  result,
  improving,
  passes,
  onStop,
}: {
  result: CompletePayload;
  improving: boolean;
  passes: PassRecord[];
  onStop: () => void;
}) {
  const s = result.score;
  const passed = s.passed;

  return (
    <div className="sheet p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-xl">
          {passed ? 'Ready to send' : improving ? 'Improving…' : 'Best version produced'}
        </h3>
        <ScoreStamp score={s.overall} passed={passed} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Job keywords covered"
          hint="Gate: the job’s must-have terms appear in your resume."
          value={s.keywordCoveragePct}
          note={s.keywordGatePassed ? 'gate passed' : 'gate not passed'}
          tone={s.keywordGatePassed ? 'good' : 'bad'}
        />
        <Metric label="Layout" hint="Clean, ATS-readable structure." value={s.formattingScore} />
        <Metric
          label="Results shown"
          hint="Bullets that state an outcome or a figure."
          value={s.evidenceScore}
        />
        <Metric
          label="Skills listed"
          hint="How completely your skills section is filled in."
          value={s.skillsCompletenessScore}
        />
      </dl>

      {improving && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 bg-brand-tint px-3 py-2.5 text-sm text-brand-dark">
          <span>
            Improving automatically, one short pass at a time. Each pass starts from the
            best version so far, so stopping never loses anything.
          </span>
          <button type="button" onClick={onStop} className="btn bg-surface">
            Stop improving
          </button>
        </div>
      )}

      {passes.length > 0 && (
        <ul className="mt-3 space-y-1 font-mono text-xs text-muted tabular">
          {passes.map((p) => (
            <li key={p.pass}>
              Improvement pass {p.pass}: {p.overall.toFixed(1)}/10
              {p.improved ? ' — better version saved' : ' — no gain, kept the previous version'}
            </li>
          ))}
        </ul>
      )}

      {!passed && !improving && s.haltExplanation && (
        <p className="mt-4 bg-warning-tint px-3 py-2.5 text-sm text-warning">
          {s.haltExplanation}
        </p>
      )}

      {/* Evidence is the one sub-score no rewrite can raise honestly: it needs results
          and figures only the user knows. The questions that ask for them already exist
          on the profile page, and nothing here pointed to them. */}
      {!passed && !improving && s.evidenceScore < 0.5 && (
        <p className="mt-3 bg-paper px-3 py-2.5 text-sm">
          Most bullets don’t state a result or a figure, which holds “Results shown” down. The{' '}
          <a href="/profile" className="font-semibold underline">
            questions on your profile
          </a>{' '}
          ask for exactly those — answering them is the only honest way to raise it.
        </p>
      )}

      {result.selfTest.issues.length > 0 && (
        <div className="mt-4 bg-danger-tint px-3 py-2.5 text-sm text-danger">
          <p className="font-semibold">Render check found problems:</p>
          <ul className="mt-1 list-disc pl-5">
            {result.selfTest.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        {/* Review leads, deliberately. Downloading straight from the generator asks you
            to trust it sight-unseen on something this consequential. */}
        <a href={`/resume/${result.snapshotId}`} className="btn btn-primary">
          Review &amp; edit →
        </a>
        <a href={`/api/export/${result.snapshotId}?format=pdf`} className="btn">
          Download PDF
        </a>
        <a href={`/api/export/${result.snapshotId}?format=docx`} className="btn">
          Download DOCX
        </a>
      </div>
      <p className="mt-2 font-mono text-xs text-muted">{result.fileNames.pdf}</p>
    </div>
  );
}

function Metric({
  label,
  hint,
  value,
  note,
  tone,
}: {
  label: string;
  hint: string;
  /** 0..1 */
  value: number;
  note?: string;
  tone?: 'good' | 'bad';
}) {
  const pct = Math.round(value * 100);
  return (
    <div className="border border-line px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`font-mono text-base font-semibold tabular ${
          tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success' : ''
        }`}
      >
        {pct}%{note && <span className="ml-2 text-xs font-normal">{note}</span>}
        <div
          className="progress mt-1"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      </dd>
      <dd className="mt-1 text-xs text-muted">{hint}</dd>
    </div>
  );
}
