'use client';

/**
 * The live pipeline panel — REQ-8.1.
 *
 * Every row here corresponds to a stage that is actually executing on the server. No
 * simulated progress, no fake timers: rows appear because an SSE event arrived. That
 * matters beyond honesty — the quality-gate rows are the product's whole argument for
 * why you should trust the output, so showing the real iteration scores IS the feature.
 */

import { useCallback, useRef, useState } from 'react';
import {
  JOB_FILE_ACCEPT,
  MAX_JOB_FILE_BYTES,
  fileRejection,
  isAcceptedJobFile,
  validateJobSubmission,
} from '@/lib/intake/job-input';
import type { PipelineEvent, PipelineStage, QualityGateResult } from '@/lib/types';

const STAGE_LABELS: Record<PipelineStage, string> = {
  sync: 'Checking your portfolio',
  understand: 'Understanding the job',
  retrieve: 'Finding your best-fit experience',
  draft: 'Drafting',
  score: 'Scoring against ATS criteria',
  finalize: 'Building your files',
};

const STAGE_ORDER: PipelineStage[] = [
  'sync',
  'understand',
  'retrieve',
  'draft',
  'score',
  'finalize',
];

interface CompletePayload {
  snapshotId: string;
  score: QualityGateResult;
  selfTest: { pdfPassed: boolean; docxPassed: boolean; issues: string[] };
  fileNames: { pdf: string; docx: string };
}

export function DraftConsole() {
  const [jobInput, setJobInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompletePayload | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  const start = useCallback(async () => {
    if (running) return;

    // The floor cannot be judged on the file's text from here — the browser has not
    // read it — so an attachment counts as "enough" and the server, which has the
    // extracted text, applies the real three-character rule.
    const rejection = validateJobSubmission(jobInput, file ? 3 : 0);
    if (rejection) {
      setError(rejection.message);
      return;
    }

    setRunning(true);
    setEvents([]);
    setError(null);
    setResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Multipart only when there is a file to carry. Without one the request is the
      // JSON it has always been, so nothing about the text-only path changes.
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

      const res = await fetch('/api/draft', { ...init, signal: controller.signal });

      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: 'Draft failed.' }));
        setError(j.error ?? 'Draft failed.');
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;

          const name = eventLine?.slice(7).trim();
          const payload = JSON.parse(dataLine.slice(6));

          if (name === 'stage') {
            setEvents((prev) => [...prev, payload as PipelineEvent]);
          } else if (name === 'complete') {
            setResult(payload as CompletePayload);
          } else if (name === 'error') {
            setError(payload.message ?? 'Draft failed.');
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message);
      }
    } finally {
      setRunning(false);
    }
  }, [file, jobInput, running]);

  const latestByStage = new Map<PipelineStage, PipelineEvent>();
  const scoreRows: PipelineEvent[] = [];
  for (const e of events) {
    if (e.stage === 'score' && e.status === 'running') scoreRows.push(e);
    else latestByStage.set(e.stage, e);
  }
  const startedStages = STAGE_ORDER.filter(
    (s) => latestByStage.has(s) || (s === 'score' && scoreRows.length > 0),
  );

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-line bg-surface p-5">
        <h2 className="font-display text-xl">Start a new resume</h2>
        <p className="mt-1 text-sm text-muted">
          Paste a job link, a full description, or a LinkedIn post — or attach the job
          description as a PDF or DOCX. Either one on its own is enough, and you can do
          both.
        </p>

        <label htmlFor="jobInput" className="sr-only">
          Job posting link or description
        </label>
        <textarea
          id="jobInput"
          value={jobInput}
          onChange={(e) => setJobInput(e.target.value)}
          placeholder="Paste a job URL, description, or LinkedIn post here…"
          rows={5}
          disabled={running}
          className="mt-4 w-full resize-y rounded-xl border border-muted bg-paper px-3.5 py-3 text-sm outline-none placeholder:text-muted focus:border-brand disabled:opacity-60"
        />

        <div className="mt-3 rounded-xl border border-dashed border-line p-3">
          {file ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 break-all font-mono text-xs text-ink">
                {file.name}
                <span className="text-muted"> · {(file.size / 1024).toFixed(0)} KB</span>
              </span>
              <button
                type="button"
                onClick={() => setFile(null)}
                disabled={running}
                className="ml-auto min-h-11 rounded-lg border border-line px-3 py-2 text-xs font-semibold hover:bg-paper disabled:opacity-50"
              >
                Remove file
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              {/* The input is hidden from sight but not from the keyboard: the label is
                  the 44px target, and focus lands on it through the association. */}
              <label
                htmlFor="jobFile"
                className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-4 py-2.5 text-sm font-semibold hover:bg-paper focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand"
              >
                Attach a PDF or DOCX
                <input
                  id="jobFile"
                  type="file"
                  accept={JOB_FILE_ACCEPT}
                  disabled={running}
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
        {error && events.length === 0 && (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-danger-tint px-3 py-2.5 text-sm text-danger"
          >
            {error}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {/*
            The disclosure belongs where the decision is made, not only in settings.
            This is the button that sends someone's name, employers and history to a
            third-party AI company, and until now nothing on the way to it said so or
            named one.
          */}
          <span className="text-xs text-muted">
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
            disabled={running || (!file && jobInput.trim().length < 3)}
            className="min-h-11 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Drafting…' : 'Draft resume →'}
          </button>
        </div>
      </div>

      {startedStages.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-5">
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">
            Live progress
          </h3>

          {/* REQ-8.1 is a live view, and "live" has to mean live for a screen reader
              too — polite so each stage is announced without interrupting. */}
          <ol className="mt-4 space-y-0" aria-live="polite" aria-busy={running}>
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

          {error && events.length > 0 && (
            <p role="alert" className="mt-4 rounded-lg bg-danger-tint px-3 py-2.5 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}

      {result && <ResultCard result={result} />}
    </div>
  );
}

const STATUS_WORDS: Record<'running' | 'done' | 'error', string> = {
  running: 'in progress',
  done: 'done',
  error: 'failed',
};

/**
 * The mark is decorative: the same status is spelled out in the sr-only text beside the
 * stage name, so nothing here is carried by shape or colour alone (WCAG 1.4.1).
 */
function StatusDot({ status }: { status: 'running' | 'done' | 'error' }) {
  const base = 'mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full text-[11px]';
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

function ResultCard({ result }: { result: CompletePayload }) {
  const s = result.score;
  const passed = s.passed;

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-display text-xl">
          {passed ? 'Ready to send' : 'Best version produced'}
        </h3>
        <span
          className={`font-mono text-2xl font-semibold tabular ${
            passed ? 'text-success' : 'text-warning'
          }`}
        >
          {s.overall.toFixed(1)}
          <span className="text-sm text-muted"> / 10</span>
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Keyword gate"
          value={`${Math.round(s.keywordCoveragePct * 100)}%`}
          tone={s.keywordGatePassed ? 'good' : 'bad'}
        />
        <Metric label="Formatting" value={pct(s.formattingScore)} />
        <Metric label="Evidence" value={pct(s.evidenceScore)} />
        <Metric label="Skills" value={pct(s.skillsCompletenessScore)} />
      </dl>

      {!passed && s.haltExplanation && (
        <p className="mt-4 rounded-lg bg-warning-tint px-3 py-2.5 text-sm text-warning">
          {s.haltExplanation}
        </p>
      )}

      {result.selfTest.issues.length > 0 && (
        <div className="mt-4 rounded-lg bg-danger-tint px-3 py-2.5 text-sm text-danger">
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
        <a
          href={`/resume/${result.snapshotId}`}
          className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
        >
          Review &amp; edit →
        </a>
        <a
          href={`/api/export/${result.snapshotId}?format=pdf`}
          className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 py-2.5 text-sm font-semibold hover:bg-paper"
        >
          Download PDF
        </a>
        <a
          href={`/api/export/${result.snapshotId}?format=docx`}
          className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 py-2.5 text-sm font-semibold hover:bg-paper"
        >
          Download DOCX
        </a>
      </div>
      <p className="mt-2 font-mono text-xs text-muted">{result.fileNames.pdf}</p>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`font-mono text-base font-semibold tabular ${
          tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
