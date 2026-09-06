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
      </fieldset>

      <fieldset className="rounded-xl border border-line bg-surface p-5">
        <legend className="px-1.5 font-display text-lg">Offer details</legend>

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
          className="min-h-11 rounded-lg px-4 py-2.5 text-sm font-semibold text-muted hover:text-danger disabled:opacity-50"
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
    <div className="mt-4">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {help ? (
        <p className="mt-0.5 max-w-prose text-xs text-muted">{help}</p>
      ) : null}
      <div className="mt-1.5">{children}</div>
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
