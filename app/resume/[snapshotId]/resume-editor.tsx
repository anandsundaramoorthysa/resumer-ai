'use client';

/**
 * Editable preview with source trace — REQ-5.7 / PLAN.md §9.
 *
 * Two things this exists for. First, you get to fix a sentence before it goes out;
 * downloading straight from the generator asks you to trust it blindly on something
 * high-stakes. Second, every generated line shows the profile record it came from, so
 * the output is auditable rather than a black box — and a line you edit yourself stops
 * claiming that provenance, because it is now your sentence, not a traced-back one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { QualityGateResult, ResumeDocument } from '@/lib/types';

interface SourceInfo {
  type: string;
  origin: string;
  text: string;
}

type Edit = {
  sectionKey: string;
  groupIndex: number | null;
  itemIndex: number;
  text: string;
};

export function ResumeEditor({
  snapshotId,
  initialDocument,
  score,
  fileName,
}: {
  snapshotId: string;
  initialDocument: ResumeDocument;
  score: QualityGateResult | null;
  fileName: string;
}) {
  const [doc, setDoc] = useState<ResumeDocument>(initialDocument);
  const [sources, setSources] = useState<Record<string, SourceInfo>>({});
  const [dirty, setDirty] = useState<Map<string, Edit>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showTrace, setShowTrace] = useState(true);

  useEffect(() => {
    fetch(`/api/resume/${snapshotId}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.sources) setSources(j.sources);
      })
      .catch(() => {});
  }, [snapshotId]);

  const setText = useCallback(
    (sectionKey: string, groupIndex: number | null, itemIndex: number, text: string) => {
      setSaved(false);
      setDoc((prev) => {
        const next = structuredClone(prev);
        const section = next.sections.find((s) => s.key === sectionKey);
        if (!section) return prev;
        const target =
          groupIndex === null
            ? section.items[itemIndex]
            : section.groups?.[groupIndex]?.items[itemIndex];
        if (!target) return prev;
        target.text = text;
        return next;
      });
      setDirty((prev) => {
        const next = new Map(prev);
        next.set(`${sectionKey}:${groupIndex}:${itemIndex}`, {
          sectionKey,
          groupIndex,
          itemIndex,
          text,
        });
        return next;
      });
    },
    [],
  );

  const save = async () => {
    if (dirty.size === 0) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/resume/${snapshotId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: [...dirty.values()] }),
      });
      if (res.ok) {
        const j = await res.json();
        setDoc(j.document);
        setDirty(new Map());
        setSaved(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const editedCount = useMemo(
    () =>
      doc.sections.reduce((n, s) => {
        const flat = [...s.items, ...(s.groups ?? []).flatMap((g) => g.items)];
        return n + flat.filter((i) => i.sourceRecordId === null).length;
      }, 0),
    [doc],
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl">
            {doc.jobRequirement?.roleTitle ?? 'Baseline resume'}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {doc.jobRequirement?.company ? `${doc.jobRequirement.company} · ` : ''}
            Edit anything before you export.
          </p>
        </div>
        {score ? (
          <div className="text-right">
            <div
              className={`font-mono text-3xl font-semibold tabular ${
                score.passed ? 'text-success' : 'text-warning'
              }`}
            >
              {score.overall?.toFixed(1)}
              <span className="text-sm text-muted"> / 10</span>
            </div>
            <div className="text-xs text-muted">
              {score.passed ? 'cleared the bar' : 'best version produced'}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
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
        <span className="ml-auto flex items-center gap-2">
          {dirty.size > 0 ? (
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="min-h-11 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
            >
              {saving ? 'Saving…' : `Save ${dirty.size} change${dirty.size === 1 ? '' : 's'}`}
            </button>
          ) : saved ? (
            <span className="text-xs text-success">Saved</span>
          ) : null}
          <a
            href={`/api/export/${snapshotId}?format=pdf`}
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-paper"
          >
            PDF
          </a>
          <a
            href={`/api/export/${snapshotId}?format=docx`}
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-paper"
          >
            DOCX
          </a>
        </span>
      </div>

      {/*
        REQ-6.2. The warning is not a footnote next to the link, it is the frame around
        it: this file has icons and colour, which is exactly what an ATS strips, ignores
        or misreads. It exists for a human — an email attachment, a recruiter, a print —
        and the one place it must never go is the box on a careers page.
      */}
      <div className="mb-4 rounded-xl border border-gold bg-gold-tint/40 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-gold">
              Presentation copy — do not upload to an application portal
            </p>
            <p className="mt-0.5 max-w-prose text-xs text-muted">
              Same words, with small vector icons beside your contact details and a colour
              accent. Send it to a person; use the plain PDF or DOCX above for any form
              that parses your resume.
            </p>
          </div>
          <a
            href={`/api/export/${snapshotId}?format=pdf&mode=presentation`}
            className="inline-flex min-h-11 items-center rounded-lg border border-gold px-4 py-2 text-sm font-semibold text-gold hover:bg-gold-tint"
          >
            Presentation PDF
          </a>
        </div>
      </div>

      {dirty.size > 0 ? (
        <p className="mb-4 rounded-lg bg-warning-tint px-3 py-2.5 text-sm text-warning">
          You have unsaved edits. Exports render from the saved version, so save before
          downloading.
        </p>
      ) : null}

      {/* The rendered resume, mirroring the ats-strict layout */}
      <article className="rounded-xl border border-line bg-surface p-7">
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

            {section.items.map((item, i) => (
              <Line
                key={i}
                text={item.text}
                sourceId={item.sourceRecordId}
                sources={sources}
                showTrace={showTrace}
                onChange={(t) => setText(section.key, null, i, t)}
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
                {group.items.map((item, i) => (
                  <Line
                    key={i}
                    text={item.text}
                    sourceId={item.sourceRecordId}
                    sources={sources}
                    showTrace={showTrace}
                    bullet
                    onChange={(t) => setText(section.key, gi, i, t)}
                  />
                ))}
              </div>
            ))}
          </section>
        ))}
      </article>

      <p className="mt-3 text-center font-mono text-xs text-muted">{fileName}</p>
    </div>
  );
}

function Line({
  text,
  sourceId,
  sources,
  showTrace,
  bullet,
  onChange,
}: {
  text: string;
  sourceId: string | null;
  sources: Record<string, SourceInfo>;
  showTrace: boolean;
  bullet?: boolean;
  onChange: (text: string) => void;
}) {
  const source = sourceId ? sources[sourceId] : null;

  return (
    <div className="group mt-2">
      <div className="flex items-start gap-2">
        {bullet ? <span className="mt-1.5 select-none text-muted">•</span> : null}
        <div
          contentEditable
          suppressContentEditableWarning
          onBlur={(e) => onChange(e.currentTarget.textContent ?? '')}
          className="min-w-0 flex-1 rounded px-1 py-0.5 text-sm outline-none hover:bg-paper focus:bg-paper focus:ring-1 focus:ring-brand"
        >
          {text}
        </div>
      </div>
      {showTrace ? (
        <p className="ml-4 mt-0.5 font-mono text-[11px] text-muted">
          {source
            ? `↳ ${source.type} · ${source.origin === 'manual' ? 'entered by you' : 'from your portfolio'}`
            : sourceId === null
              ? '↳ written or edited by you'
              : '↳ source record no longer in your profile'}
        </p>
      ) : null}
    </div>
  );
}
