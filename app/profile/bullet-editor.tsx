'use client';

/**
 * Writing an experience bullet.
 *
 * Three labelled fields rather than one textarea, because the evidence grader scores
 * action + scale + outcome and a single blank box reliably produces only the action —
 * the shape that scores zero. The live checks make the missing two thirds visible while
 * typing instead of after a resume has been generated from it.
 *
 * There is deliberately no "write this for me". Everything else in this product is built
 * on nothing being invented; a generator here would remove the one source of truth the
 * grounding guard verifies against.
 */

import { useState, useTransition } from 'react';
import { assessBullet, BULLET_EXAMPLE, type BulletParts } from '@/lib/profile/bullet';
import { addBullet, editBullet, deleteProfileRecord, type Result } from './record-actions';

export interface ExistingBullet {
  id: string;
  action: string;
  scale?: string;
  outcome?: string;
  text: string;
}

export function BulletEditor({
  roleId,
  roleLabel,
  bullets,
}: {
  roleId: string;
  roleLabel: string;
  bullets: ExistingBullet[];
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(bullets.length === 0);
  const [result, setResult] = useState<Result | null>(null);

  return (
    <div className="mt-3">
      {bullets.length === 0 && !adding ? (
        <p className="text-sm text-warning">
          Nothing recorded for this role, so it cannot appear on a resume.
        </p>
      ) : null}

      <ul className="space-y-2">
        {bullets.map((b) =>
          editing === b.id ? (
            <li key={b.id}>
              <BulletForm
                roleId={roleId}
                initial={b}
                recordId={b.id}
                onDone={(r) => {
                  setResult(r);
                  if (r.ok) setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li
              key={b.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-line px-3.5 py-2.5"
            >
              <span className="min-w-0 text-sm">{b.text}</span>
              <span className="flex flex-none gap-1">
                <button
                  type="button"
                  onClick={() => setEditing(b.id)}
                  className="min-h-11 rounded-lg px-2.5 text-xs font-semibold text-brand-dark hover:bg-paper"
                >
                  Edit
                </button>
                <DeleteButton id={b.id} onDone={setResult} />
              </span>
            </li>
          ),
        )}
      </ul>

      {adding ? (
        <div className="mt-2">
          <BulletForm
            roleId={roleId}
            onDone={(r) => {
              setResult(r);
              if (r.ok) setAdding(false);
            }}
            onCancel={bullets.length > 0 ? () => setAdding(false) : undefined}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 min-h-11 rounded-lg border border-line px-3.5 text-sm font-semibold hover:bg-paper"
        >
          + Add an accomplishment to {roleLabel}
        </button>
      )}

      {result ? (
        <p
          className={`mt-2 text-xs ${result.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

function BulletForm({
  roleId,
  recordId,
  initial,
  onDone,
  onCancel,
}: {
  roleId: string;
  recordId?: string;
  initial?: BulletParts;
  onDone: (r: Result) => void;
  onCancel?: () => void;
}) {
  const [parts, setParts] = useState<BulletParts>({
    action: initial?.action ?? '',
    scale: initial?.scale ?? '',
    outcome: initial?.outcome ?? '',
  });
  const [pending, startTransition] = useTransition();

  const assessment = assessBullet(parts);
  const canSave = parts.action.trim().length > 0 && !pending;

  const submit = () => {
    startTransition(async () => {
      const r = recordId
        ? await editBullet(recordId, roleId, parts.action, parts.scale ?? '', parts.outcome ?? '')
        : await addBullet(roleId, parts.action, parts.scale ?? '', parts.outcome ?? '');
      onDone(r);
      if (r.ok && !recordId) setParts({ action: '', scale: '', outcome: '' });
    });
  };

  return (
    <div className="rounded-lg border border-brand-tint bg-paper p-3.5">
      <Field
        label="What did you do?"
        value={parts.action}
        placeholder={BULLET_EXAMPLE.action}
        onChange={(v) => setParts({ ...parts, action: v })}
      />
      <Field
        label="At what scale?"
        value={parts.scale ?? ''}
        placeholder={BULLET_EXAMPLE.scale}
        onChange={(v) => setParts({ ...parts, scale: v })}
      />
      <Field
        label="What changed as a result?"
        value={parts.outcome ?? ''}
        placeholder={BULLET_EXAMPLE.outcome}
        onChange={(v) => setParts({ ...parts, outcome: v })}
      />

      {assessment.text ? (
        <p className="mt-3 rounded border border-line bg-surface px-3 py-2 text-sm">
          {assessment.text}
        </p>
      ) : null}

      <ul className="mt-2.5 space-y-1">
        {assessment.checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-xs">
            <span className={c.ok ? 'text-success' : 'text-muted'}>{c.ok ? '✓' : '○'}</span>
            <span className={c.ok ? 'text-muted' : ''}>
              {c.label}
              {!c.ok ? <span className="text-muted"> — {c.hint}</span> : null}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-muted">
        Save it either way — a real accomplishment with no number attached still belongs
        on your resume, and inventing one is worse than a weak line.
      </p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!canSave}
          className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
        >
          {pending ? 'Saving…' : recordId ? 'Save' : 'Add'}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 rounded-lg px-4 text-sm font-semibold text-muted hover:text-ink"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mt-2 block first:mt-0">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-sm outline-none focus:border-brand"
      />
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
