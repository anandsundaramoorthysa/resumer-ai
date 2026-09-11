'use client';

/**
 * The AI profile assistant — STEWARD.md §3, "where it sits" 1.
 *
 * Two tools behind one card. "Review my profile" walks the profile section by section and
 * lists what the steward found, each with its reason and a before/after, to apply or
 * dismiss. "Add with AI" turns a few sentences into profile entries the user ticks.
 *
 * Nothing changes until a button is pressed on a specific suggestion, and nothing the
 * assistant shows can add a fact the profile does not hold: that was checked on the server
 * before the suggestion was sent (lib/steward/verify.ts).
 */

import { useMemo, useState, useTransition } from 'react';
import { STEWARD_SECTIONS, type StewardSection, type Suggestion } from '@/lib/steward/types';
import type { AssistantExtraction } from '@/lib/server/steward';
import {
  applyQuickFixesAction,
  applySuggestionAction,
  commitFromAssistantAction,
  dismissSuggestionAction,
  extractForProfileAction,
  reviewSectionAction,
} from './steward-actions';

type Tab = 'review' | 'add';

export function ProfileAssistant({ empty }: { empty: boolean }) {
  const [tab, setTab] = useState<Tab>(empty ? 'add' : 'review');

  return (
    <section className="mt-7 rounded-xl border border-brand bg-surface p-5" aria-labelledby="assistant-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-prose">
          <h2 id="assistant-heading" className="font-display text-lg">
            AI profile assistant
          </h2>
          <p className="mt-1 text-sm text-muted">
            Finds duplicates, weak wording, things filed in the wrong place and facts that are
            missing — and turns a few sentences into profile entries. It only proposes: nothing
            changes until you apply it, and it never adds a fact you did not give.
          </p>
        </div>
      </div>

      <div className="mt-4 flex w-full max-w-md rounded-lg border border-line p-1" role="tablist">
        {(
          [
            ['review', 'Review my profile'],
            ['add', 'Add with AI'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`min-h-11 flex-1 rounded-md px-2 text-sm font-semibold ${
              tab === id ? 'bg-brand text-on-brand' : 'text-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className={tab === 'review' ? '' : 'hidden'}>
        <ReviewTool />
      </div>
      <div className={tab === 'add' ? '' : 'hidden'}>
        <AddTool />
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- review -- */

type RunState =
  | { phase: 'idle' }
  | { phase: 'running'; done: number; total: number; current: string }
  | { phase: 'done'; failedSections: string[] };

function ReviewTool() {
  const [run, setRun] = useState<RunState>({ phase: 'idle' });
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulkPending, startBulk] = useTransition();

  const start = async () => {
    setSuggestions([]);
    setNotice(null);
    const found: Suggestion[] = [];
    const failed = new Set<string>();
    // Every section's first batch is known up front; later batches are learnt from it.
    const queue: Array<{ section: StewardSection; batch: number; retried?: boolean }> = STEWARD_SECTIONS.map((s) => ({ section: s.id, batch: 0 }));
    let total = queue.length;
    let done = 0;
    setRun({ phase: 'running', done, total, current: STEWARD_SECTIONS[0].label });

    const retry: Array<{ section: StewardSection; batch: number; retried?: boolean }> = [];

    const worker = async () => {
      while (queue.length > 0) {
        const job = queue.shift()!;
        const label = STEWARD_SECTIONS.find((s) => s.id === job.section)?.label ?? job.section;
        setRun({ phase: 'running', done, total, current: label });
        // A request can fail outright — a dropped connection, a deploy mid-review. That is
        // a failed batch, not a stuck page: it goes the same way as a model that timed out.
        const res = await reviewSectionAction(job.section, job.batch).catch(
          () => ({ ok: true as const, data: { section: job.section, batch: job.batch, batches: 1, suggestions: [], model: 'failed' as const } }),
        );
        done++;
        if (!res.ok) {
          failed.add(label);
          setNotice(res.message);
        } else {
          if (job.batch === 0) {
            for (let b = 1; b < res.data.batches; b++) queue.push({ section: job.section, batch: b });
            total += res.data.batches - 1;
          }
          if (res.data.model === 'failed') {
            if (!job.retried) retry.push({ ...job, retried: true });
            else failed.add(label);
          }
          found.push(...res.data.suggestions);
          setSuggestions(order(dedupe(found)));
        }
        setRun({ phase: 'running', done, total, current: label });
      }
    };
    // Two at a time. Each request is one model call against a shared provider chain, and
    // three at once earned rate-limit refusals from it rather than finishing sooner.
    await Promise.all([worker(), worker()]);
    // One more pass at whatever the providers could not serve. A failed batch is usually a
    // busy provider, not a broken request, and a retry costs seconds where re-running the
    // whole review costs minutes.
    if (retry.length > 0) {
      queue.push(...retry.splice(0, retry.length));
      total += queue.length;
      await worker();
    }
    setRun({ phase: 'done', failedSections: [...failed] });
  };

  /** Drops suggestions made against records an applied one just changed. */
  const settle = (applied: Suggestion) => {
    const touched = new Set([...Object.keys(applied.basis), ...(applied.removeIds ?? [])]);
    setSuggestions((list) => {
      const rest = list.filter((s) => s.id !== applied.id);
      const kept = rest.filter((s) => !Object.keys(s.basis).some((id) => touched.has(id)));
      if (kept.length < rest.length) {
        setNotice(`${rest.length - kept.length} related suggestion${rest.length - kept.length === 1 ? ' was' : 's were'} cleared because that record changed. Review again to recheck it.`);
      }
      return kept;
    });
  };

  const quick = suggestions.filter((s) => s.quick && s.kind === 'fix' && s.origin === 'rule');
  const running = run.phase === 'running';

  return (
    <div className="mt-4">
      {run.phase === 'idle' ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={start}
            className="min-h-11 rounded-lg bg-brand px-5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
          >
            Review my profile
          </button>
          <span className="text-xs text-muted">A minute or two. Uses a little of today’s AI allowance.</span>
        </div>
      ) : null}

      {running ? (
        <div role="status" aria-live="polite">
          <p className="text-sm">
            Checking {run.current}… <span className="text-muted tabular">({run.done} of {run.total} steps)</span>
          </p>
          <div className="mt-2 h-2 w-full max-w-md overflow-hidden rounded-full bg-line" aria-hidden>
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.round((run.done / Math.max(1, run.total)) * 100)}%` }} />
          </div>
        </div>
      ) : null}

      {notice ? <p className="mt-3 rounded-lg bg-warning-tint px-3 py-2 text-sm text-warning">{notice}</p> : null}

      {run.phase === 'done' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold" role="status">
            {suggestions.length === 0
              ? 'Nothing left to fix — your profile reads consistently.'
              : `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}`}
          </p>
          {quick.length > 0 ? (
            <button
              type="button"
              disabled={bulkPending}
              onClick={() =>
                startBulk(async () => {
                  // A few per request: one request for forty of them is a long write that
                  // the host cuts off at thirty seconds, which is a 502 mid-apply.
                  let done = 0;
                  let failed = 0;
                  for (let i = 0; i < quick.length; i += QUICK_CHUNK) {
                    const chunk = quick.slice(i, i + QUICK_CHUNK);
                    const res = await applyQuickFixesAction(chunk).catch(() => ({
                      ok: false as const,
                      message: 'The connection dropped while applying. What was applied is saved; review again for the rest.',
                    }));
                    if (!res.ok) {
                      setNotice(res.message);
                      break;
                    }
                    const applied = new Set(res.data.applied);
                    done += res.data.applied.length;
                    failed += res.data.failed;
                    // A fix changes the record it touched, so anything else proposed
                    // against that record was judged on words that no longer exist.
                    const touched = new Set(
                      chunk.filter((x) => applied.has(x.id)).flatMap((x) => Object.keys(x.basis)),
                    );
                    setSuggestions((list) =>
                      list.filter((x) => !applied.has(x.id) && !Object.keys(x.basis).some((id) => touched.has(id))),
                    );
                    setNotice(`Applying quick fixes… ${done} of ${quick.length}`);
                  }
                  setNotice(
                    `Applied ${done} quick fix${done === 1 ? '' : 'es'}${failed ? `; ${failed} could not be applied — review again` : ''}. Suggestions about those records were cleared; review again to recheck them.`,
                  );
                })
              }
              className="min-h-11 rounded-lg border border-brand px-4 text-sm font-semibold text-brand-dark hover:bg-brand-tint disabled:opacity-50"
            >
              {bulkPending ? 'Applying…' : `Apply ${quick.length} quick fix${quick.length === 1 ? '' : 'es'}`}
            </button>
          ) : null}
          <button type="button" onClick={start} className="min-h-11 rounded-lg px-3 text-sm font-semibold text-muted hover:text-ink">
            Review again
          </button>
          {run.failedSections.length > 0 ? (
            <p className="w-full text-xs text-muted">
              The AI part could not run for {run.failedSections.join(', ')}; the checks that need no AI are still shown.
            </p>
          ) : null}
        </div>
      ) : null}

      {STEWARD_SECTIONS.map(({ id, label }) => {
        const list = suggestions.filter((s) => s.section === id);
        if (list.length === 0) return null;
        return (
          <div key={id} className="mt-5">
            <h3 className="text-sm font-semibold">
              {label} <span className="font-normal text-muted tabular">· {list.length}</span>
            </h3>
            <ul className="mt-2 space-y-2">
              {list.map((s) => (
                <SuggestionCard key={s.id} suggestion={s} onSettled={settle} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function dedupe(list: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

/**
 * Quick fixes per request. Each is a read, a write and an audit row — measured at well
 * under a second against the production database, so twelve sit inside the host's thirty
 * seconds with room to spare, and a profile of seventy takes six requests rather than
 * fifteen.
 */
const QUICK_CHUNK = 12;

const KIND_ORDER: Record<Suggestion['kind'], number> = { merge: 0, remove: 1, move: 2, fix: 3, ask: 4 };
function order(list: Suggestion[]): Suggestion[] {
  return [...list].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

const APPLY_LABEL: Record<Suggestion['kind'], string> = {
  fix: 'Apply',
  merge: 'Merge',
  remove: 'Remove',
  move: 'Move',
  ask: 'Save answer',
};

function show(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ') || '(empty)';
  const s = value == null ? '' : String(value);
  return s || '(empty)';
}

function SuggestionCard({ suggestion: s, onSettled }: { suggestion: Suggestion; onSettled: (s: Suggestion) => void }) {
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const needsAnswer = Boolean(s.ask);

  const apply = () =>
    start(async () => {
      setError(null);
      const res = await applySuggestionAction(s, answer).catch(() => ({
        ok: false as const,
        message: 'The connection dropped. Try again.',
      }));
      if (!res.ok) return setError(res.message);
      onSettled(s);
    });

  const dismiss = () =>
    start(async () => {
      const res = await dismissSuggestionAction(s.id).catch(() => ({ ok: false as const, message: 'The connection dropped. Try again.' }));
      if (!res.ok) return setError(res.message);
      onSettled({ ...s, basis: {} });
    });

  return (
    <li className="rounded-lg border border-line bg-paper px-3.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted [overflow-wrap:anywhere]">{s.label}</p>
          <p className="mt-0.5 text-sm font-semibold [overflow-wrap:anywhere]">{s.title}</p>
        </div>
        <span
          className={`flex-none rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            s.origin === 'ai' ? 'bg-brand-tint text-brand-dark' : 'bg-line text-muted'
          }`}
        >
          {s.origin === 'ai' ? 'AI' : 'Check'}
        </span>
      </div>

      {s.changes
        ? Object.entries(s.changes).map(([field, c]) => (
            <div key={field} className="mt-2 grid gap-1 text-sm sm:grid-cols-2 sm:gap-3">
              <p className="rounded bg-danger-tint/40 px-2 py-1 text-muted line-through decoration-danger/60 [overflow-wrap:anywhere]">
                <span className="sr-only">Before: </span>
                {show(c.from)}
              </p>
              <p className="rounded bg-success-tint/50 px-2 py-1 [overflow-wrap:anywhere]">
                <span className="sr-only">After: </span>
                {show(c.to)}
              </p>
            </div>
          ))
        : null}

      <p className="mt-2 text-xs text-muted">{s.reason}</p>

      {needsAnswer ? (
        <label className="mt-2 block text-sm">
          <span className="font-medium">{s.ask!.prompt}</span>
          <input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={s.ask!.placeholder}
            className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-brand"
          />
          <span className="mt-1 block text-xs text-muted">Saved exactly as you type it.</span>
        </label>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={pending || (needsAnswer && !answer.trim())}
          className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
        >
          {pending ? 'Working…' : APPLY_LABEL[s.kind]}
        </button>
        <button
          type="button"
          onClick={dismiss}
          disabled={pending}
          className="min-h-11 rounded-lg px-3 text-sm font-semibold text-muted hover:text-ink disabled:opacity-50"
        >
          Dismiss
        </button>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------ Add with AI -- */

function AddTool() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<AssistantExtraction | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reading, startRead] = useTransition();
  const [saving, startSave] = useTransition();

  const read = () =>
    startRead(async () => {
      setMessage(null);
      setResult(null);
      const res = await extractForProfileAction(text).catch(() => ({
        ok: false as const,
        message: 'The connection dropped. Try again.',
      }));
      if (!res.ok) return setMessage({ ok: false, text: res.message });
      setResult(res.data);
      setSelected(new Set([
        ...res.data.records.filter((r) => !r.duplicateOf).map((r) => r.key),
        ...res.data.roles.map((r) => r.key),
      ]));
    });

  const count = useMemo(() => selected.size, [selected]);

  const save = () =>
    startSave(async () => {
      if (!result) return;
      const payload = {
        roles: result.roles
          .filter((r) => selected.has(r.key))
          .map((r) => ({
            title: r.title,
            company: r.company,
            startDate: r.startDate,
            endDate: r.endDate || 'present',
            bullets: r.bullets.map((b) => ({ text: b, action: b, tags: [] })),
          })),
        records: result.records.filter((r) => selected.has(r.key)).map((r) => r.record),
      };
      const res = await commitFromAssistantAction(payload, text).catch(() => ({
        ok: false as const,
        message: 'The connection dropped. Check your profile before adding again.',
      }));
      setMessage({ ok: res.ok, text: res.ok ? (res.message ?? 'Added.') : res.message });
      if (res.ok) {
        setResult(null);
        setText('');
      }
    });

  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="mt-4">
      <label className="block text-sm font-medium" htmlFor="assistant-text">
        Tell it about something you have done
      </label>
      <textarea
        id="assistant-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={2000}
        placeholder="At D2R AI Labs I automated invoice processing with Python and n8n. I also earned the Google Data Analytics certificate in March 2025."
        className="mt-1.5 w-full resize-y rounded-xl border border-line bg-paper px-3.5 py-3 text-sm outline-none focus:border-brand"
      />
      <p className="mt-1 text-xs text-muted">
        Only what you write is used. Anything it cannot trace back to your words is left out, and it tells you what.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={read}
          disabled={reading || text.trim().length < 10}
          className="min-h-11 rounded-lg bg-brand px-5 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
        >
          {reading ? 'Reading…' : 'Turn into profile entries'}
        </button>
        {message ? (
          <p role="status" className={`text-sm ${message.ok ? 'text-success' : 'text-danger'}`}>
            {message.text}
          </p>
        ) : null}
      </div>

      {result ? (
        <div className="mt-4 rounded-lg border border-line bg-paper p-3.5">
          {result.records.length === 0 && result.roles.length === 0 ? (
            <p className="text-sm">Nothing in that could be turned into a profile entry. Name the skill, project or role, and what you did.</p>
          ) : (
            <>
              <p className="text-sm font-semibold">Tick what to add</p>
              <ul className="mt-2 space-y-1">
                {result.roles.map((r) => (
                  <li key={r.key}>
                    <label className="flex min-h-11 items-start gap-3 py-1.5 text-sm">
                      <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} className="mt-1 h-4 w-4 flex-none accent-brand" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        Role · {r.title}{r.company ? ` at ${r.company}` : ''}
                        {r.bullets.map((b, i) => (
                          <span key={i} className="mt-0.5 block text-xs text-muted">• {b}</span>
                        ))}
                      </span>
                    </label>
                  </li>
                ))}
                {result.records.map((r) => (
                  <li key={r.key}>
                    <label className="flex min-h-11 items-start gap-3 py-1.5 text-sm">
                      <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} className="mt-1 h-4 w-4 flex-none accent-brand" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {r.label}
                        {r.duplicateOf ? (
                          <span className="mt-0.5 block text-xs text-warning">Already in your profile as {r.duplicateOf}</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={save}
                disabled={saving || count === 0}
                className="mt-3 min-h-11 rounded-lg bg-brand px-5 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
              >
                {saving ? 'Adding…' : `Add ${count} to profile`}
              </button>
            </>
          )}
          {result.dropped.length > 0 ? (
            <div className="mt-3 text-xs text-muted">
              <p className="font-semibold">Left out, because your words did not say it:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.dropped.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.unplaced.length > 0 ? (
            <div className="mt-3 text-xs text-muted">
              <p className="font-semibold">Did not fit any profile section:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.unplaced.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
