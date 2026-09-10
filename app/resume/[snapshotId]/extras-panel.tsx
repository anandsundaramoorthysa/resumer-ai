'use client';

/**
 * Cover letter and interview prep, generated on request from the finished resume.
 *
 * The interview panel deliberately highlights questions you have NO evidence for. That
 * is the uncomfortable half, and it is the half worth knowing before you are asked it
 * live — the same honesty the quality gate applies to the resume itself.
 */

import { useState } from 'react';

interface Letter {
  greeting: string;
  paragraphs: string[];
  closing: string;
  removed: string[];
}

interface Prep {
  questions: Array<{
    question: string;
    why: string;
    yourEvidence: string;
    category: string;
    hasEvidence: boolean;
  }>;
  gapQuestions: number;
}

export function ExtrasPanel({ snapshotId }: { snapshotId: string }) {
  const [tab, setTab] = useState<'letter' | 'interview' | null>(null);
  const [letter, setLetter] = useState<{ letter: Letter; text: string } | null>(null);
  const [prep, setPrep] = useState<Prep | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async (kind: 'cover-letter' | 'interview') => {
    setTab(kind === 'cover-letter' ? 'letter' : 'interview');
    if (kind === 'cover-letter' && letter) return;
    if (kind === 'interview' && prep) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/resume/${snapshotId}/extras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Generation failed.');
        return;
      }
      if (kind === 'cover-letter') setLetter({ letter: json.letter, text: json.text });
      else setPrep(json.prep);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mt-6 rounded-xl border border-line bg-surface p-5">
      <h2 className="font-display text-xl">Also from this resume</h2>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Both are built from the resume above, so they can only say what it already says.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => load('cover-letter')}
          className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-semibold ${
            tab === 'letter' ? 'border-brand text-brand-dark' : 'border-line hover:bg-paper'
          }`}
        >
          Cover letter
        </button>
        <button
          type="button"
          onClick={() => load('interview')}
          className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-semibold ${
            tab === 'interview'
              ? 'border-brand text-brand-dark'
              : 'border-line hover:bg-paper'
          }`}
        >
          Interview prep
        </button>
      </div>

      {loading ? <p className="mt-4 text-sm text-muted">Generating…</p> : null}
      {error ? (
        <p className="mt-4 rounded-lg bg-danger-tint px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {tab === 'letter' && letter && !loading ? (
        <div className="mt-4">
          {/*
            * Capped at a reading measure, unlike the panel around it.
            *
            * A cover letter is continuous prose and this is the copy you paste into an
            * application, so it is read here before it is sent. `whitespace-pre-wrap`
            * means it wraps to whatever it is given, and in the 1152px page shell that
            * was paragraphs about 170 characters wide — roughly two and a half times a
            * comfortable line, and the length at which the eye loses the start of the
            * next line. The panel's buttons and warnings underneath still span the card.
            */}
          <div className="max-w-prose whitespace-pre-wrap rounded-lg border border-line bg-paper p-4 text-sm leading-relaxed">
            {letter.text}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(letter.text);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-paper"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            {letter.letter.removed.length > 0 ? (
              <span className="text-xs text-warning">
                {letter.letter.removed.length} sentence
                {letter.letter.removed.length === 1 ? '' : 's'} dropped for claiming
                something your resume doesn&apos;t support
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === 'interview' && prep && !loading ? (
        <div className="mt-4">
          {prep.gapQuestions > 0 ? (
            <p className="mb-3 rounded-lg bg-warning-tint px-3 py-2.5 text-sm text-warning">
              {prep.gapQuestions} of these have no evidence in your resume. Those are the
              ones to prepare an honest answer for.
            </p>
          ) : null}
          {/* Two columns from `lg`. Each question is a short card — a question, one line
              of why, and a quote from the resume — and ten of them stacked full-width in
              the 1152px shell was a column of near-empty boxes three screens tall. Paired
              up, the whole prep sheet is close to one screen, which is how it gets used:
              scanned before an interview, not read through. */}
          <ul className="grid gap-3 lg:grid-cols-2">
            {prep.questions.map((q, i) => (
              <li
                key={i}
                className={`rounded-lg border p-3.5 ${
                  q.hasEvidence ? 'border-line' : 'border-warning bg-warning-tint/30'
                }`}
              >
                <p className="text-sm font-semibold">{q.question}</p>
                <p className="mt-1 text-xs text-muted">{q.why}</p>
                {q.hasEvidence ? (
                  <p className="mt-2 border-l-2 border-success pl-2.5 text-xs">
                    {q.yourEvidence}
                  </p>
                ) : (
                  <p className="mt-2 text-xs font-medium text-warning">
                    Nothing in your resume answers this yet.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
