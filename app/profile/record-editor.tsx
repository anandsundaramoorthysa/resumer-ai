'use client';

/**
 * Adding, editing and removing any record type.
 *
 * The fields are not written here — they come from `lib/profile/forms.ts`, the same
 * definition the server validates against, so a field cannot exist in the form and be
 * unknown to the write, or the reverse.
 *
 * As with bullets, there is no "generate this for me". A profile is the one place in
 * this product where every fact has to be the user's own.
 */

import { useState, useTransition } from 'react';
import {
  RECORD_FORMS,
  articleFor,
  coerceFormValues,
  describeRecord,
  missingRequired,
  type FieldDef,
  type RecordForm,
} from '@/lib/profile/forms';
import { deleteProfileRecord, saveRecord, type Result } from './record-actions';

/**
 * Where a fact came from, said plainly. "synced" for everything that was not typed by
 * hand was accurate while GitHub was the only other source; with an import and a
 * LinkedIn export in the mix it stopped telling the user anything.
 */
const SOURCE_LABELS: Record<string, string> = {
  manual: 'typed',
  'github-sync': 'portfolio',
  'ai-import': 'imported',
  linkedin: 'LinkedIn',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export interface EditableRecord {
  id: string;
  source: string;
  data: Record<string, unknown>;
}

/** Lists round-trip through the comma-separated text the form shows. */
function toFormValues(form: RecordForm, data: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of form.fields) {
    const v = data[field.name];
    values[field.name] = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
  }
  return values;
}

function blankValues(form: RecordForm): Record<string, string> {
  const values: Record<string, string> = {};
  // A select with no choice made is not "empty" — it is the first option, which is what
  // the user sees selected before touching it.
  for (const field of form.fields) {
    values[field.name] = field.kind === 'select' ? (field.options?.[0] ?? '') : '';
  }
  return values;
}

/**
 * The type is passed, not the form object.
 *
 * A `RecordForm` carries a `describe` function, and a function cannot cross the server /
 * client boundary — React refuses to serialise it and the whole page returns 500. Passing
 * the type string and looking the form up here keeps one definition without sending a
 * function over the wire. `lib/profile/forms.ts` is pure and dependency-free precisely so
 * that it can be imported on both sides.
 */
export function RecordEditor({
  type,
  records,
  chips,
  single,
  compact,
}: {
  type: string;
  records: EditableRecord[];
  chips?: boolean;
  /** One record is the most this type can hold — a summary, not a list of them. */
  single?: boolean;
  /**
   * Used where several empty types share one card. "Nothing recorded yet." repeated six
   * times says nothing the absence of content did not already say.
   */
  compact?: boolean;
}) {
  const form = RECORD_FORMS[type];
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const editingRecord = records.find((r) => r.id === editing) ?? null;

  return (
    <div>
      {records.length === 0 ? (
        compact ? null : (
          <p className="mt-3 text-sm text-muted">Nothing recorded yet.</p>
        )
      ) : chips ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {records.map((r) => (
            <span
              key={r.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand-tint py-1 pl-2.5 pr-1 text-xs font-medium text-brand-dark"
              title={`Source: ${sourceLabel(r.source)}`}
            >
              {describeRecord(form.type, r.data)}
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setEditing(r.id);
                  setAdding(false);
                }}
                aria-label={`Edit ${describeRecord(form.type, r.data)}`}
                /* 24x24 is WCAG 2.2 AA's floor (2.5.8). At px-1 this was 20x16, which is
                   not reliably hittable with a thumb. Sized without inflating the chip. */
                className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full hover:bg-surface"
              >
                &#9998;
              </button>
            </span>
          ))}
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {records.map((r) =>
            editing === r.id ? (
              <li key={r.id}>
                <RecordFields
                  form={form}
                  recordId={r.id}
                  initial={toFormValues(form, r.data)}
                  onDone={(res) => {
                    setResult(res);
                    if (res.ok) setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li
                key={r.id}
                /* Stacked below `sm`. Side by side, the actions are flex-none and take
                   their width first, leaving the text an 83px column that ran to twenty
                   lines at 320px — nothing overflowed or clipped, it just became an
                   unreadable ribbon. */
                className="flex flex-col items-start gap-2 rounded-lg border border-line px-3.5 py-2.5 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-3"
              >
                <span className="min-w-0">
                  {describeRecord(form.type, r.data)}
                  <span className="ml-2 font-mono text-[11px] text-muted">
                    {sourceLabel(r.source)}
                  </span>
                </span>
                <span className="flex flex-none gap-1 self-end sm:self-auto">
                  <button
                    type="button"
                    onClick={() => {
                      setResult(null);
                      setEditing(r.id);
                      setAdding(false);
                    }}
                    /* px-3 rather than px-2.5: at 2.5 the box measured 43px, one pixel
                       under the 44px touch target this codebase holds itself to. */
                    className="min-h-11 rounded-lg px-3 text-xs font-semibold text-brand-dark hover:bg-paper"
                  >
                    Edit
                  </button>
                  <DeleteButton id={r.id} onDone={setResult} />
                </span>
              </li>
            ),
          )}
        </ul>
      )}

      {/* A chip being edited opens its form below the row, since a chip has no room. */}
      {chips && editingRecord ? (
        <div className="mt-3">
          <RecordFields
            form={form}
            recordId={editingRecord.id}
            initial={toFormValues(form, editingRecord.data)}
            onDone={(res) => {
              setResult(res);
              if (res.ok) setEditing(null);
            }}
            onCancel={() => setEditing(null)}
            onDelete={(res) => {
              setResult(res);
              if (res.ok) setEditing(null);
            }}
          />
        </div>
      ) : null}

      {adding ? (
        <div className="mt-3">
          <RecordFields
            form={form}
            initial={blankValues(form)}
            onDone={(res) => {
              setResult(res);
              if (res.ok) setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : single && records.length > 0 ? null : (
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setAdding(true);
            setEditing(null);
          }}
          className="mt-3 min-h-11 rounded-lg border border-line px-3.5 text-sm font-semibold hover:bg-paper"
        >
          + Add {articleFor(form.singular)} {form.singular}
        </button>
      )}

      {result ? (
        <p className={`mt-2 text-xs ${result.ok ? 'text-success' : 'text-danger'}`} role="status">
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

function RecordFields({
  form,
  recordId,
  initial,
  onDone,
  onCancel,
  onDelete,
}: {
  form: RecordForm;
  recordId?: string;
  initial: Record<string, string>;
  onDone: (r: Result) => void;
  onCancel: () => void;
  onDelete?: (r: Result) => void;
}) {
  const [values, setValues] = useState(initial);
  const [pending, startTransition] = useTransition();

  // The same registry check the server runs, so the button explains itself before a
  // round trip rather than after one.
  const missing = missingRequired(form, coerceFormValues(form, values));

  const submit = () => {
    startTransition(async () => {
      const r = await saveRecord(form.type, recordId ?? null, values);
      onDone(r);
      if (r.ok && !recordId) setValues(initial);
    });
  };

  return (
    <div className="rounded-lg border border-brand-tint bg-paper p-3.5">
      {form.fields.map((field) => (
        <Field
          key={field.name}
          field={field}
          value={values[field.name] ?? ''}
          onChange={(v) => setValues({ ...values, [field.name]: v })}
        />
      ))}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || missing.length > 0}
          className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
        >
          {pending ? 'Saving…' : recordId ? 'Save' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 rounded-lg px-4 text-sm font-semibold text-muted hover:text-ink"
        >
          Cancel
        </button>
        {recordId && onDelete ? <DeleteButton id={recordId} onDone={onDelete} /> : null}
        {missing.length > 0 ? (
          <span className="text-xs text-muted">{missing.join(' and ')} needed</span>
        ) : null}
      </div>
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  const shared =
    'mt-1 w-full rounded-lg border border-muted bg-surface px-3 py-2 text-sm outline-none focus:border-brand';

  return (
    <label className="mt-2.5 block first:mt-0">
      <span className="text-xs font-medium text-muted">
        {field.label}
        {field.required ? <span className="text-danger"> *</span> : null}
      </span>

      {field.kind === 'textarea' ? (
        <textarea
          value={value}
          rows={3}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={shared}
        />
      ) : field.kind === 'select' ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${shared} min-h-11`}
        >
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={value}
          maxLength={field.maxLength}
          placeholder={
            field.kind === 'list'
              ? (field.placeholder ?? 'One, another, a third')
              : field.placeholder
          }
          onChange={(e) => onChange(e.target.value)}
          className={`${shared} min-h-11`}
        />
      )}

      {field.kind === 'list' ? (
        <span className="mt-1 block text-xs text-muted">Separate with commas.</span>
      ) : null}
      {field.hint ? <span className="mt-1 block text-xs text-muted">{field.hint}</span> : null}
    </label>
  );
}

function DeleteButton({ id, onDone }: { id: string; onDone: (r: Result) => void }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => onDone(await deleteProfileRecord(id)))}
      className="min-h-11 rounded-lg px-2.5 text-xs font-semibold text-danger hover:bg-danger-tint disabled:opacity-50"
    >
      Remove
    </button>
  );
}
