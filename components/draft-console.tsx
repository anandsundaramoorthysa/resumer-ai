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
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompletePayload | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async () => {
    if (!jobInput.trim() || running) return;

    setRunning(true);
    setEvents([]);
    setError(null);
    setResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobInput }),
        signal: controller.signal,
      });

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
  }, [jobInput, running]);

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
          Paste a job link, a full description, or a LinkedIn post — whatever you have.
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
          className="mt-4 w-full resize-y rounded-xl border border-line bg-paper px-3.5 py-3 text-sm outline-none placeholder:text-muted focus:border-brand disabled:opacity-60"
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted">
            Your portfolio is re-checked for changes before drafting.
          </span>
          <button
            type="button"
            onClick={start}
            disabled={running || jobInput.trim().length < 3}
            className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Drafting…' : 'Draft resume →'}
          </button>
        </div>
      </div>

      {(startedStages.length > 0 || error) && (
        <div className="rounded-2xl border border-line bg-surface p-5">
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">
            Live progress
          </h3>

          <ol className="mt-4 space-y-0">
            {startedStages.map((stage) => {
              const event = latestByStage.get(stage);
              const isScore = stage === 'score';
              const status = event?.status ?? 'running';

              return (
                <li key={stage} className="border-b border-line py-3 last:border-b-0">
                  <div className="flex items-start gap-3">
                    <StatusDot status={status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{STAGE_LABELS[stage]}</div>

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

          {error && (
            <p className="mt-4 rounded-lg bg-danger-tint px-3 py-2.5 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}

      {result && <ResultCard result={result} />}
    </div>
  );
}

function StatusDot({ status }: { status: 'running' | 'done' | 'error' }) {
  const base = 'mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full text-[11px]';
  if (status === 'done')
    return <span className={`${base} bg-success-tint text-success`}>✓</span>;
  if (status === 'error')
    return <span className={`${base} bg-danger-tint text-danger`}>!</span>;
  return (
    <span className={`${base} bg-brand-tint text-brand-dark`}>
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
        <a
          href={`/api/export/${result.snapshotId}?format=pdf`}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark"
        >
          Download PDF
        </a>
        <a
          href={`/api/export/${result.snapshotId}?format=docx`}
          className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold hover:bg-paper"
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
