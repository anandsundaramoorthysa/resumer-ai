'use client';

/**
 * Editable preview with source trace — REQ-5.7 / PLAN.md §9.
 *
 * Two things this exists for. First, you get to fix a sentence before it goes out;
 * downloading straight from the generator asks you to trust it blindly on something
 * high-stakes. Second, every generated line shows the profile record it came from, so
 * the output is auditable rather than a black box — and a line whose text you actually
 * change stops claiming that provenance, because it is now your sentence. Clicking into
 * a line and leaving it unchanged keeps its trace.
 *
 * Edits autosave (debounced) through the existing PATCH endpoint. Exports render from
 * the saved version, so export links are disabled while anything is unsaved.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { QualityGateResult, ResumeDocument } from '@/lib/types';
import { ScoreStamp } from '@/components/score-stamp';

interface SourceInfo {
  type: string;
  origin: string;
  text: string;
}

interface Flat {
  sectionKey: string;
  groupIndex: number | null;
  itemIndex: number;
  text: string;
  sourceRecordId: string | null;
}

const AUTOSAVE_MS = 1500;
const keyOf = (sectionKey: string, groupIndex: number | null, itemIndex: number) =>
  `${sectionKey}:${groupIndex}:${itemIndex}`;

/** Every editable line of a document, by stable key (lines are never added or removed here). */
function flatten(doc: ResumeDocument): Map<string, Flat> {
  const out = new Map<string, Flat>();
  for (const s of doc.sections) {
    s.items.forEach((it, i) =>
      out.set(keyOf(s.key, null, i), {
        sectionKey: s.key,
        groupIndex: null,
        itemIndex: i,
        text: it.text,
        sourceRecordId: it.sourceRecordId,
      }),
    );
    (s.groups ?? []).forEach((g, gi) =>
      g.items.forEach((it, i) =>
        out.set(keyOf(s.key, gi, i), {
          sectionKey: s.key,
          groupIndex: gi,
          itemIndex: i,
          text: it.text,
          sourceRecordId: it.sourceRecordId,
        }),
      ),
    );
  }
  return out;
}

export function ResumeEditor({
  snapshotId,
  initialDocument,
  score,
  fileName,
  sent,
}: {
  snapshotId: string;
  initialDocument: ResumeDocument;
  score: QualityGateResult | null;
  fileName: string;
  /** Its application has left draft: this is what was sent, so it is read-only. */
  sent: boolean;
}) {
  // The last version the server confirmed. Source trace comes from here, so a line you
  // have not changed keeps its trace no matter how many others you edit.
  const [savedDoc, setSavedDoc] = useState<ResumeDocument>(initialDocument);
  // Text typed into a line, by line key. Only entries that differ from savedDoc count.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, SourceInfo>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [showTrace, setShowTrace] = useState(true);

  const saved = useMemo(() => flatten(savedDoc), [savedDoc]);
  const generated = useMemo(() => flatten(initialDocument), [initialDocument]);

  const dirtyKeys = useMemo(
    () => Object.keys(drafts).filter((k) => saved.has(k) && drafts[k] !== saved.get(k)!.text),
    [drafts, saved],
  );
  const unsaved = dirtyKeys.length > 0 || saving;

  useEffect(() => {
    fetch(`/api/resume/${snapshotId}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.sources) setSources(j.sources);
      })
      .catch(() => {});
  }, [snapshotId]);

  const setLine = useCallback((key: string, text: string) => {
    setJustSaved(false);
    setSaveError(null);
    setDrafts((prev) => ({ ...prev, [key]: text }));
  }, []);

  const save = useCallback(async () => {
    const current = drafts;
    const edits = Object.keys(current)
      .filter((k) => saved.has(k) && current[k] !== saved.get(k)!.text)
      .map((k) => {
        const f = saved.get(k)!;
        return {
          sectionKey: f.sectionKey,
          groupIndex: f.groupIndex,
          itemIndex: f.itemIndex,
          text: current[k],
        };
      });
    if (edits.length === 0) return;

    inFlight.current = Object.fromEntries(
      edits.map((e) => [keyOf(e.sectionKey, e.groupIndex, e.itemIndex), e.text]),
    );
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/resume/${snapshotId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits }),
      });
      if (res.ok) {
        const j = (await res.json()) as { document: ResumeDocument };
        const next = flatten(j.document);
        setSavedDoc(j.document);
        // Keep anything typed while the request was in flight; drop what is now saved.
        setDrafts((cur) => {
          const kept: Record<string, string> = {};
          for (const k of Object.keys(cur)) {
            if (cur[k] !== next.get(k)?.text) kept[k] = cur[k];
          }
          return kept;
        });
        setJustSaved(true);
      } else {
        // A refused save used to look exactly like a save that had not been pressed.
        const j = await res.json().catch(() => null);
        setSaveError(j?.error ?? 'Your changes could not be saved. Try again.');
      }
    } catch {
      setSaveError('Your changes could not be saved. Check your connection and try again.');
    } finally {
      inFlight.current = {};
      setSaving(false);
    }
  }, [drafts, saved, snapshotId]);

  // Client-side navigation never fires beforeunload, so flush on unmount. Lines already
  // carried by an in-flight save (same text) are left out so nothing is sent twice.
  const latest = useRef({ drafts, saved, sent });
  const inFlight = useRef<Record<string, string>>({});
  useEffect(() => {
    latest.current = { drafts, saved, sent };
  });
  useEffect(() => {
    return () => {
      const { drafts: d, saved: s, sent: ro } = latest.current;
      if (ro) return;
      const edits = Object.keys(d)
        .filter((k) => s.has(k) && d[k] !== s.get(k)!.text && inFlight.current[k] !== d[k])
        .map((k) => {
          const f = s.get(k)!;
          return { sectionKey: f.sectionKey, groupIndex: f.groupIndex, itemIndex: f.itemIndex, text: d[k] };
        });
      if (edits.length === 0) return;
      void fetch(`/api/resume/${snapshotId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [snapshotId]);

  // Debounced autosave. After a failure it waits for the next edit (or "Try saving
  // again") instead of hammering a server that just said no.
  useEffect(() => {
    if (sent || saving || saveError || dirtyKeys.length === 0) return;
    const t = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [drafts, dirtyKeys.length, saving, saveError, sent, save]);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const editedCount = useMemo(() => {
    let n = 0;
    for (const [k, f] of saved) {
      if (f.sourceRecordId === null || dirtyKeys.includes(k)) n++;
    }
    return n;
  }, [saved, dirtyKeys]);

  const status = saveError
    ? 'Not saved'
    : saving
      ? 'Saving…'
      : dirtyKeys.length > 0
        ? 'Unsaved changes'
        : justSaved
          ? 'Saved'
          : '';

  const exportLink = (href: string, label: string, primary: boolean) =>
    unsaved ? (
      <button type="button" disabled aria-describedby="export-locked" className={`btn ${primary ? 'btn-primary' : ''}`}>
        {label}
      </button>
    ) : (
      <a href={href} className={`btn ${primary ? 'btn-primary' : ''}`}>
        {label}
      </a>
    );

  const doc = savedDoc;
  const lineProps = (sectionKey: string, groupIndex: number | null, i: number, ariaLabel: string) => {
    const key = keyOf(sectionKey, groupIndex, i);
    const f = saved.get(key)!;
    const text = drafts[key] ?? f.text;
    return {
      ariaLabel,
      text,
      sourceId: f.sourceRecordId,
      changed: text !== f.text,
      canRevert: text !== (generated.get(key)?.text ?? f.text),
      sources,
      showTrace,
      readOnly: sent,
      onChange: (t: string) => setLine(key, t),
      onUndo: () => setLine(key, f.text),
      onRevert: () => setLine(key, generated.get(key)?.text ?? f.text),
    };
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Review</p>
          <h1 className="font-display text-3xl">
            {doc.jobRequirement?.roleTitle ?? 'Baseline resume'}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {doc.jobRequirement?.company ? `${doc.jobRequirement.company} · ` : ''}
            {sent
              ? 'Sent with an application, so it is kept exactly as it was sent.'
              : 'Edit anything before you export. Changes save automatically.'}
          </p>
        </div>
        <ScoreStamp score={score?.overall ?? null} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 border border-line bg-surface px-4 py-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showTrace}
            onChange={(e) => setShowTrace(e.target.checked)}
            className="accent-brand"
          />
          Show where each line came from
        </label>
        <span className="text-xs text-muted">
          {editedCount > 0
            ? `${editedCount} line${editedCount === 1 ? '' : 's'} written or edited by you`
            : 'every line traces back to your profile'}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <span
            role="status"
            aria-live="polite"
            className={`text-xs font-semibold ${
              status === 'Saved'
                ? 'text-success'
                : status === 'Not saved'
                  ? 'text-danger'
                  : 'text-warning'
            }`}
          >
            {status}
          </span>
          {dirtyKeys.length > 0 && !saving ? (
            <button type="button" onClick={() => void save()} className="btn btn-primary">
              {saveError ? 'Try saving again' : 'Save now'}
            </button>
          ) : null}
        </span>
      </div>

      {saveError ? (
        <p role="alert" className="mb-4 bg-danger-tint px-3 py-2.5 text-sm text-danger">
          {saveError} Your edits are still on this page.
        </p>
      ) : null}

      {/*
        REQ-6.2. The presentation copy has icons and colour, which an ATS strips or
        misreads; it is for a person (an email attachment, a print). The standard PDF
        and DOCX are what go into an application portal.
      */}
      <div className="mb-4 border border-line bg-surface px-4 py-3">
        <p className="eyebrow">Export</p>
        <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-3">
          <div>
            {exportLink(`/api/export/${snapshotId}?format=pdf`, 'Download PDF', true)}
            <p className="mt-1 text-xs text-muted">Plain and ATS-safe. The one to send.</p>
          </div>
          <div>
            {exportLink(`/api/export/${snapshotId}?format=docx`, 'Download DOCX', false)}
            <p className="mt-1 text-xs text-muted">Editable in Word, for portals that ask for it.</p>
          </div>
          <div>
            {exportLink(
              `/api/export/${snapshotId}?format=pdf&mode=presentation`,
              'Presentation PDF',
              false,
            )}
            <p className="mt-1 max-w-xs text-xs text-muted">
              Has icons and colour. For people, not application forms.
            </p>
          </div>
        </div>
        {unsaved ? (
          <p id="export-locked" className="mt-3 text-xs text-warning">
            Exports use the saved version, so downloads unlock once your changes are saved.
          </p>
        ) : null}
      </div>

      {/*
        * The rendered resume, mirroring the ats-strict layout, capped at a US Letter-ish
        * measure on purpose: bullets are written and scored against that width, and a
        * preview stretched to the page shell stops resembling the file it previews.
        */}
      <article className="sheet mx-auto max-w-4xl p-4 sm:p-7">
        <header className="border-b border-line pb-4">
          <h2 className="text-xl font-bold">{doc.contact.fullName}</h2>
          <p className="mt-1 text-sm text-muted">
            {[doc.contact.email, doc.contact.phone, doc.contact.location]
              .filter(Boolean)
              .join('  |  ')}
          </p>
          <p className="text-sm text-muted">
            {[doc.contact.portfolioUrl, doc.contact.githubUrl, doc.contact.linkedinUrl]
              .filter(Boolean)
              .join('  |  ')}
          </p>
        </header>

        {doc.sections.map((section) => (
          <section key={section.key} className="mt-6">
            <h3 className="border-b border-ink pb-1 text-sm font-bold uppercase tracking-wide">
              {section.heading}
            </h3>

            {section.items.map((_, i) => (
              <Line
                key={i}
                {...lineProps(section.key, null, i, `${section.heading} bullet ${i + 1}`)}
              />
            ))}

            {(section.groups ?? []).map((group, gi) => (
              <div key={gi} className="mt-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold">
                    {group.title}
                    {group.subtitle ? (
                      <span className="font-normal"> — {group.subtitle}</span>
                    ) : null}
                  </p>
                  {group.dateRange ? (
                    <span className="font-mono text-xs text-muted">{group.dateRange}</span>
                  ) : null}
                </div>
                {group.items.map((_, i) => (
                  <Line
                    key={i}
                    bullet
                    {...lineProps(
                      section.key,
                      gi,
                      i,
                      `${section.heading}, ${group.title}, bullet ${i + 1}`,
                    )}
                  />
                ))}
              </div>
            ))}
          </section>
        ))}
      </article>

      <p className="mt-3 text-center font-mono text-xs text-muted [overflow-wrap:anywhere]">
        {fileName}
      </p>
    </div>
  );
}

function Line({
  ariaLabel,
  text,
  sourceId,
  changed,
  canRevert,
  sources,
  showTrace,
  bullet,
  readOnly,
  onChange,
  onUndo,
  onRevert,
}: {
  ariaLabel: string;
  text: string;
  sourceId: string | null;
  /** Text differs from the last saved version. */
  changed: boolean;
  /** Text differs from what the generator wrote. */
  canRevert: boolean;
  sources: Record<string, SourceInfo>;
  showTrace: boolean;
  bullet?: boolean;
  readOnly?: boolean;
  onChange: (text: string) => void;
  onUndo: () => void;
  onRevert: () => void;
}) {
  const source = sourceId ? sources[sourceId] : null;
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: collapse first so the box can also shrink.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const showActions = !readOnly && (changed || canRevert);

  return (
    <div className="mt-2">
      <div className="flex items-start gap-2">
        {bullet ? (
          <span aria-hidden className="mt-1.5 select-none text-muted">
            •
          </span>
        ) : null}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          aria-label={ariaLabel}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
          className="block min-w-0 flex-1 resize-none overflow-hidden bg-transparent px-1 py-0.5 text-sm leading-relaxed hover:bg-paper focus:bg-paper"
        />
      </div>
      {showTrace || showActions ? (
        <p className="ml-4 mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-xs text-muted">
          {showTrace ? (
            <span>
              {changed || sourceId === null
                ? '↳ written or edited by you'
                : source
                  ? `↳ ${source.type} · ${source.origin === 'manual' ? 'entered by you' : 'from your portfolio'}`
                  : '↳ source record no longer in your profile'}
            </span>
          ) : null}
          {!readOnly && changed ? (
            <button type="button" onClick={onUndo} className="min-h-6 font-sans font-semibold text-ink underline">
              Undo<span className="sr-only"> change to {ariaLabel}</span>
            </button>
          ) : null}
          {!readOnly && canRevert ? (
            <button type="button" onClick={onRevert} className="min-h-6 font-sans font-semibold text-ink underline">
              Revert to generated<span className="sr-only"> for {ariaLabel}</span>
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
