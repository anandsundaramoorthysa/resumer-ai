/**
 * One definition per record type, shared by the form and the server.
 *
 * The alternative — a form component listing fields and a server action validating a
 * different list — drifts the moment a field is added, and drifts silently: the input
 * renders, the user types, and the value is dropped on the way in. Defining fields once
 * means the browser and the database cannot disagree about what a record is.
 *
 * Pure and dependency-free so the same registry runs in a client component, in the
 * server action, and in tests.
 */

import { certificationHashParts } from '../sync/certifications';
import type { ProfileRecord } from '../types';
import { educationHashParts } from '../sync/education';

export type FieldKind = 'text' | 'textarea' | 'list' | 'select';

export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  placeholder?: string;
  /** For `select`. */
  options?: string[];
  /** Shown under the input — used where the right answer is not obvious. */
  hint?: string;
  maxLength?: number;
}

export interface RecordForm {
  type: string;
  singular: string;
  plural: string;
  fields: FieldDef[];
  /**
   * Which fields identify the record, for the content hash. These must match the recipe
   * lib/sync/parse.ts uses for the same type, or a hand-written fact and the synced one
   * it duplicates hash differently and both survive.
   */
  identityFields: string[];
  /** The hash's first element, where it is not the type name — sync writes 'cert'. */
  hashPrefix?: string;
  /**
   * Replaces the whole hash input for types whose identity is not a plain field list.
   *
   * Education needs it: the sync hashes a normalised identity so that "M.Sc." and
   * "M.Sc. Data Science" at "Loyola College" and "Loyola College (Autonomous), Chennai"
   * collide. Hashing the raw fields here instead meant a hand-typed degree would not
   * collide with its synced twin, so the duplicate check never fired for that one type.
   */
  hashParts?: (data: Record<string, unknown>) => string[];
  /** Builds the one-line display string. */
  describe: (data: Record<string, unknown>) => string;
}

const str = (data: Record<string, unknown>, k: string): string =>
  typeof data[k] === 'string' ? (data[k] as string) : '';

const list = (data: Record<string, unknown>, k: string): string[] =>
  Array.isArray(data[k]) ? (data[k] as string[]) : [];

const joined = (parts: Array<string | undefined>, sep = ' · '): string =>
  parts.filter((p) => p && p.trim()).join(sep);

export const RECORD_FORMS: Record<string, RecordForm> = {
  skill: {
    type: 'skill',
    singular: 'skill',
    plural: 'Skills',
    fields: [
      { name: 'name', label: 'Skill', kind: 'text', required: true, placeholder: 'PostgreSQL', maxLength: 80 },
      {
        name: 'category',
        label: 'Kind',
        kind: 'select',
        options: ['language', 'framework', 'tool', 'platform', 'soft-skill'],
      },
    ],
    identityFields: ['name', 'category'],
    describe: (d) => str(d, 'name'),
  },

  project: {
    type: 'project',
    singular: 'project',
    plural: 'Projects',
    fields: [
      { name: 'name', label: 'Project', kind: 'text', required: true, maxLength: 120 },
      { name: 'description', label: 'What is it?', kind: 'textarea', maxLength: 600 },
      { name: 'stack', label: 'Built with', kind: 'list', placeholder: 'React, PostgreSQL' },
      { name: 'links', label: 'Links', kind: 'list', placeholder: 'github.com/you/repo' },
      {
        name: 'impactMetrics',
        label: 'What it achieved',
        kind: 'list',
        placeholder: 'Cut page load 40%',
        hint: 'A measurable result. This is what the evidence score reads — a project with none scores nothing.',
      },
    ],
    identityFields: ['name', 'description', 'stack'],
    describe: (d) => joined([str(d, 'name'), str(d, 'description').slice(0, 90)], ' — '),
  },

  education: {
    type: 'education',
    singular: 'qualification',
    plural: 'Education',
    fields: [
      { name: 'credential', label: 'Degree', kind: 'text', required: true, placeholder: 'B.Sc. Computer Science' },
      { name: 'institution', label: 'Institution', kind: 'text', required: true },
      { name: 'field', label: 'Field', kind: 'text' },
      { name: 'startDate', label: 'Started', kind: 'text', placeholder: '2022-06', hint: 'Year, or YYYY-MM.' },
      { name: 'endDate', label: 'Finished', kind: 'text', placeholder: '2026-05' },
    ],
    identityFields: ['institution', 'credential'],
    hashParts: (d) =>
      educationHashParts({
        institution: str(d, 'institution'),
        credential: str(d, 'credential'),
        field: str(d, 'field') || undefined,
      }),
    describe: (d) =>
      joined([str(d, 'credential'), str(d, 'field'), str(d, 'institution')]),
  },

  certification: {
    type: 'certification',
    singular: 'certification',
    plural: 'Certifications',
    fields: [
      { name: 'name', label: 'Certification', kind: 'text', required: true },
      { name: 'issuer', label: 'Issued by', kind: 'text', required: true },
      { name: 'issuedDate', label: 'Date', kind: 'text', placeholder: '2025-03' },
      { name: 'credentialUrl', label: 'Link', kind: 'text' },
    ],
    identityFields: ['name', 'issuer'],
    hashPrefix: 'cert',
    // The same normalised recipe the sync uses. Without it a certificate typed by hand
    // hashes on its raw text while the synced twin hashes on a normalised identity, so
    // the duplicate check never fires between the two routes — the education entry below
    // had exactly that problem.
    hashParts: (d) =>
      certificationHashParts({ name: str(d, 'name'), issuer: str(d, 'issuer') }),
    describe: (d) => joined([str(d, 'name'), str(d, 'issuer')]),
  },

  publication: {
    type: 'publication',
    singular: 'publication',
    plural: 'Publications',
    fields: [
      { name: 'title', label: 'Title', kind: 'text', required: true },
      { name: 'venue', label: 'Conference or journal', kind: 'text', required: true },
      { name: 'date', label: 'Date', kind: 'text', placeholder: '2025-08' },
      { name: 'doi', label: 'DOI', kind: 'text' },
      {
        name: 'status',
        label: 'Status',
        kind: 'select',
        options: ['published', 'under-review', 'preprint'],
      },
    ],
    identityFields: ['title'],
    describe: (d) => joined([str(d, 'title'), str(d, 'venue'), str(d, 'date')]),
  },

  writing: {
    type: 'writing',
    singular: 'article',
    plural: 'Writing',
    fields: [
      { name: 'title', label: 'Title', kind: 'text', required: true },
      { name: 'venue', label: 'Published on', kind: 'text', required: true, placeholder: 'Medium' },
      { name: 'date', label: 'Date', kind: 'text' },
      { name: 'url', label: 'Link', kind: 'text' },
    ],
    identityFields: ['title'],
    describe: (d) => joined([str(d, 'title'), str(d, 'venue')]),
  },

  award: {
    type: 'award',
    singular: 'award',
    plural: 'Awards',
    fields: [
      { name: 'title', label: 'Award', kind: 'text', required: true },
      { name: 'issuer', label: 'Awarded by', kind: 'text' },
      { name: 'date', label: 'Date', kind: 'text' },
      { name: 'description', label: 'What for', kind: 'textarea', maxLength: 400 },
    ],
    identityFields: ['title'],
    describe: (d) => joined([str(d, 'title'), str(d, 'issuer')]),
  },

  achievement: {
    type: 'achievement',
    singular: 'achievement',
    plural: 'Achievements',
    fields: [
      { name: 'title', label: 'Achievement', kind: 'text', required: true },
      { name: 'description', label: 'Detail', kind: 'textarea', maxLength: 400 },
      { name: 'date', label: 'Date', kind: 'text' },
    ],
    identityFields: ['title'],
    describe: (d) => joined([str(d, 'title'), str(d, 'description')], ' — '),
  },

  language: {
    type: 'language',
    singular: 'language',
    plural: 'Languages',
    fields: [
      { name: 'name', label: 'Language', kind: 'text', required: true, placeholder: 'Tamil' },
      {
        name: 'proficiency',
        label: 'Level',
        kind: 'select',
        options: ['native', 'fluent', 'professional', 'conversational', 'basic'],
      },
    ],
    identityFields: ['name'],
    describe: (d) => joined([str(d, 'name'), str(d, 'proficiency')], ' — '),
  },

  volunteering: {
    type: 'volunteering',
    singular: 'role',
    plural: 'Volunteering',
    fields: [
      { name: 'role', label: 'Role', kind: 'text', required: true },
      { name: 'organization', label: 'Organisation', kind: 'text', required: true },
      { name: 'date', label: 'When', kind: 'text' },
      { name: 'description', label: 'What you did', kind: 'textarea', maxLength: 400 },
    ],
    identityFields: ['organization', 'role'],
    describe: (d) => joined([str(d, 'role'), str(d, 'organization')]),
  },

  interest: {
    type: 'interest',
    singular: 'interest',
    plural: 'Interests',
    fields: [{ name: 'name', label: 'Interest', kind: 'text', required: true, maxLength: 60 }],
    identityFields: ['name'],
    describe: (d) => str(d, 'name'),
  },

  summary: {
    type: 'summary',
    singular: 'summary',
    plural: 'Summary',
    fields: [
      {
        name: 'text',
        label: 'Professional summary',
        kind: 'textarea',
        required: true,
        maxLength: 1200,
        hint: 'Two or three sentences. Research calls this the most-read section on a resume.',
      },
    ],
    identityFields: ['text'],
    describe: (d) => str(d, 'text'),
  },
};

/**
 * Experience bullets are absent on purpose: they belong to a role and are edited by
 * `app/profile/bullet-editor.tsx`, which captures action/scale/outcome separately
 * because the evidence grader reads those three fields.
 */
export const EDITABLE_TYPES = Object.keys(RECORD_FORMS);

export function formFor(type: string): RecordForm | null {
  return RECORD_FORMS[type] ?? null;
}

/** Renders any record to one line, falling back rather than showing raw JSON. */
export function describeRecord(type: string, data: Record<string, unknown>): string {
  const form = formFor(type);
  if (form) {
    const described = form.describe(data);
    if (described.trim()) return described;
  }
  if (type === 'experience-bullet') return str(data, 'text');
  return str(data, 'name') || str(data, 'title') || JSON.stringify(data).slice(0, 120);
}

/** Normalises submitted values: lists arrive as comma-separated text from the form. */
export function coerceFormValues(
  form: RecordForm,
  raw: Record<string, string>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = (raw[field.name] ?? '').trim();
    if (field.kind === 'list') {
      data[field.name] = value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      continue;
    }
    // Absent optional fields are omitted rather than stored as empty strings, so a
    // record's shape reflects what is actually known about it.
    if (value) data[field.name] = value;
  }
  return data;
}

export function missingRequired(form: RecordForm, data: Record<string, unknown>): string[] {
  return form.fields
    .filter((f) => f.required)
    .filter((f) => {
      const v = data[f.name];
      if (Array.isArray(v)) return v.length === 0;
      return typeof v !== 'string' || v.trim().length === 0;
    })
    .map((f) => f.label);
}

/** The full hash input for a record, prefix included. */
export function hashInput(form: RecordForm, data: Record<string, unknown>): string[] {
  if (form.hashParts) return form.hashParts(data);
  return [form.hashPrefix ?? form.type, ...identityParts(form, data)];
}

export function identityParts(
  form: RecordForm,
  data: Record<string, unknown>,
): string[] {
  return form.identityFields.map((f) => {
    const v = data[f];
    return Array.isArray(v) ? v.join(',') : String(v ?? '');
  });
}

export function tagSource(form: RecordForm, data: Record<string, unknown>): string {
  return form.fields
    .map((f) => {
      const v = data[f.name];
      return Array.isArray(v) ? v.join(' ') : String(v ?? '');
    })
    .join(' ');
}

export type { ProfileRecord };
