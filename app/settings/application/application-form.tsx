'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  clearApplicationFields,
  saveApplicationFields,
  type ActionResult,
} from './actions';
import { EEO_QUESTIONS, WORK_AUTHORIZATION_OPTIONS } from './questions';

export interface ApplicationFieldValues {
  workAuthorization: string | null;
  visaSponsorshipNeeded: boolean | null;
  salaryExpectation: string | null;
  noticePeriod: string | null;
  eeoAnswers: Record<string, string> | null;
}

export function ApplicationFieldsForm({ values }: { values: ApplicationFieldValues }) {
  const [state, action, saving] = useActionState<ActionResult | null, FormData>(
    saveApplicationFields,
    null,
  );
  const [cleared, setCleared] = useState<ActionResult | null>(null);
  const [clearing, startClearing] = useTransition();

  const sponsorship =
    values.visaSponsorshipNeeded === true
      ? 'yes'
      : values.visaSponsorshipNeeded === false
        ? 'no'
        : '';

  return (
    <form action={action} className="mt-6 space-y-5">
      <fieldset className="rounded-xl border border-line bg-surface p-5">
        <legend className="px-1.5 font-display text-lg">Right to work</legend>

        {/*
          * Two fields to a row from `sm`.
          *
          * Every control in this form is `w-full`, which was fine when the page was a
          * 768px column and is not now that it is the 1.6fr side of a 1152px shell: a
          * one-column stack put a yes/no select 690px wide, which looks like a mistake
          * and makes the form scroll for no reason. Pairing the fields fixes both — the
          * controls land near 330px, which is a sensible size for a select, and the
          * fieldset fills its column because there are two of them side by side.
          */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            id="workAuthorization"
            label="Work authorization"
            help="How you are entitled to work where you are applying."
          >
            <Select
              id="workAuthorization"
              name="workAuthorization"
              defaultValue={values.workAuthorization ?? ''}
              options={WORK_AUTHORIZATION_OPTIONS}
            />
          </Field>

          <Field
            id="visaSponsorshipNeeded"
            label="Will you need visa sponsorship?"
            help="Asked on almost every application, and worded as a yes/no even when the honest answer is “not yet”."
          >
            <Select
              id="visaSponsorshipNeeded"
              name="visaSponsorshipNeeded"
              defaultValue={sponsorship}
              options={[
                { value: '', label: 'Not answered' },
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No' },
              ]}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-xl border border-line bg-surface p-5">
        <legend className="px-1.5 font-display text-lg">Offer details</legend>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            id="salaryExpectation"
            label="Salary expectation"
            help="Free text — a range, a number, or a note like “open, depends on scope”."
          >
            <input
              id="salaryExpectation"
              name="salaryExpectation"
              type="text"
              defaultValue={values.salaryExpectation ?? ''}
              placeholder="e.g. 18–24 LPA, or $120k–$140k"
              className="min-h-11 w-full rounded-lg border border-muted bg-paper px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
          </Field>

          <Field id="noticePeriod" label="Notice period" help="How soon you could start.">
            <input
              id="noticePeriod"
              name="noticePeriod"
              type="text"
              defaultValue={values.noticePeriod ?? ''}
              placeholder="e.g. 30 days, or immediately"
              className="min-h-11 w-full rounded-lg border border-muted bg-paper px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-xl border border-line bg-surface p-5">
        <legend className="px-1.5 font-display text-lg">
          Voluntary self-identification
        </legend>
        <p className="max-w-prose text-sm text-muted">
          These are the EEO questions attached to most applications. They are voluntary
          there and voluntary here — every one of them can be left unanswered, and
          &ldquo;prefer not to say&rdquo; is itself a valid answer to store, because that is
          what many forms expect you to select.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {EEO_QUESTIONS.map((question) => (
            <Field key={question.id} id={`eeo.${question.id}`} label={question.label}>
              <Select
                id={`eeo.${question.id}`}
                name={`eeo.${question.id}`}
                defaultValue={values.eeoAnswers?.[question.id] ?? ''}
                options={question.options}
              />
            </Field>
          ))}
        </div>
      </fieldset>

      {state ? (
        <p
          role="status"
          className={`rounded-lg px-3.5 py-2.5 text-sm ${
            state.ok ? 'bg-success-tint text-success' : 'bg-danger-tint text-danger'
          }`}
        >
          {state.message}
        </p>
      ) : null}
      {cleared ? (
        <p role="status" className="rounded-lg bg-success-tint px-3.5 py-2.5 text-sm text-success">
          {cleared.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="min-h-11 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save answers'}
        </button>
        <button
          type="button"
          disabled={clearing}
          onClick={() =>
            startClearing(async () => setCleared(await clearApplicationFields()))
          }
          /* Coloured at rest and pushed away from Save. It wipes every stored answer and
             was styled identically to a Cancel link until hovered — and on touch there is
             no hover, so the only warning never appeared. This matches the delete button
             in app/profile/record-editor.tsx. */
          className="ml-auto min-h-11 rounded-lg px-4 py-2.5 text-sm font-semibold text-danger hover:bg-danger-tint disabled:opacity-50"
        >
          {clearing ? 'Clearing…' : 'Clear everything'}
        </button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    /*
     * No margin of its own, and the control is pushed to the bottom.
     *
     * The grid in each fieldset owns the vertical rhythm now, so a `mt-4` here would
     * double-space the rows. The column layout is the less obvious half: paired into two
     * columns, "Work authorization" has one line of help text and "Will you need visa
     * sponsorship?" has two, so the two selects in that row sat 16px apart vertically —
     * near enough to look accidental rather than deliberate. A full-height flex column
     * with the control on `mt-auto` puts every control in a row on the same baseline
     * however long the help above it runs.
     */
    <div className="flex h-full flex-col">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {help ? (
        <p className="mt-0.5 max-w-prose text-xs text-muted">{help}</p>
      ) : null}
      <div className="mt-auto pt-1.5">{children}</div>
    </div>
  );
}

function Select({
  id,
  name,
  defaultValue,
  options,
}: {
  id: string;
  name: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      id={id}
      name={name}
      defaultValue={defaultValue}
      className="min-h-11 w-full rounded-lg border border-muted bg-paper px-3 py-2.5 text-sm outline-none focus:border-brand"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
