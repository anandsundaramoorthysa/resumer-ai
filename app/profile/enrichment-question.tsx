'use client';

/**
 * One question the last draft could not answer for itself.
 *
 * Built as the third member of the family that already lives on this page — the sync
 * review queue and the flagged list — and deliberately the only one of the three with a
 * text box in it. The other two ask you to decide about words that already exist; this
 * one asks for words that do not, which is why a row with two buttons is not enough and
 * why only three of these are ever on screen at once (QUESTIONS_SHOWN, and the reasoning
 * beside it in lib/profile/enrichment.ts).
 *
 * The card leads with the user's own line, not with the question. Someone scanning a
 * profile page recognises their own bullet in a fraction of the time it takes to parse a
 * prompt about it, and a question they cannot place is one they skip.
 *
 * There is no "suggest an answer" here, and there will not be. Everything upstream —
 * the grounding check, `holdsKeyword`, the halt message — exists so that no number
 * reaches a resume unless the user stated it. A suggested figure would arrive with a
 * button that says Save next to it, which is the same fabrication with an extra click.
 */

import { useState, useTransition } from 'react';
import { answerQuestion, skipQuestion } from './actions';

export interface QuestionView {
  id: string;
  kind: 'bullet' | 'project' | 'skill';
  topic: string;
  quote: string;
  context: string;
  reason: string;
  /** Which halves of a bullet are still blank — recomputed from the live record. */
  missing: Array<'scale' | 'outcome'>;
}

const INPUT =
  'mt-1 min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-sm outline-none focus:border-brand';

export function EnrichmentQuestion({ question }: { question: QuestionView }) {
  const [scale, setScale] = useState('');
  const [outcome, setOutcome] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const asksScale = question.kind === 'bullet' && question.missing.includes('scale');
  const asksOutcome = question.kind === 'bullet' && question.missing.includes('outcome');
  const filled =
    question.kind === 'bullet' ? Boolean(scale.trim() || outcome.trim()) : Boolean(text.trim());

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await answerQuestion(question.id, { scale, outcome, text });
      // Only a failure is announced. On success the card is gone on the next render —
      // the profile it was asking about now contains the answer — and a toast about a
      // component that no longer exists is noise.
      if (!result.ok) setError(result.message);
    });
  };

  return (
    <li className="rounded-lg border border-line bg-surface p-3.5">
      <p className="text-sm">
        {question.kind === 'skill' ? (
          <>
            <span className="font-semibold">{question.topic}</span>
            {question.context ? (
              <span className="text-muted"> · asked for by {question.context}</span>
            ) : null}
          </>
        ) : (
          <>
            <span className="italic">&ldquo;{question.quote}&rdquo;</span>
            {question.context ? (
              <span className="text-muted"> · {question.context}</span>
            ) : null}
          </>
        )}
      </p>

      {question.reason ? (
        <p className="mt-1.5 text-xs text-muted">{question.reason}</p>
      ) : null}

      <div className="mt-3">
        {asksScale ? (
          <label className="block">
            <span className="text-xs font-medium text-muted">
              How big was it — how many, how often, or for whom?
            </span>
            <input
              value={scale}
              onChange={(e) => setScale(e.target.value)}
              placeholder="serving 200K requests a day"
              className={INPUT}
            />
          </label>
        ) : null}

        {asksOutcome ? (
          <label className="mt-2 block first:mt-0">
            <span className="text-xs font-medium text-muted">
              What changed because of it?
            </span>
            <input
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="cutting p95 latency 40%"
              className={INPUT}
            />
          </label>
        ) : null}

        {question.kind === 'project' ? (
          <label className="block">
            <span className="text-xs font-medium text-muted">
              What did it achieve? One measurable result.
            </span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="used by 40 people a week"
              className={INPUT}
            />
          </label>
        ) : null}

        {question.kind === 'skill' ? (
          <label className="block">
            <span className="text-xs font-medium text-muted">
              Where did you use {question.topic}? One line.
            </span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="ran the staging cluster at Northwind for two years"
              className={INPUT}
            />
          </label>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!filled || pending}
          className="min-h-11 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Add to my profile'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => skipQuestion(question.id))}
          className="min-h-11 rounded-lg px-3 py-2 text-sm font-semibold text-muted hover:text-ink disabled:opacity-50"
        >
          {question.kind === 'skill' ? "I haven't used it" : 'Skip this one'}
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
