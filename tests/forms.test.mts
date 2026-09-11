/**
 * The shared field registry — lib/profile/forms.ts.
 *
 * The registry exists so the form and the server cannot disagree about what a record is.
 * These assertions hold that property: every type is complete, every identity field is a
 * real field, and values survive the trip through the form's string representation.
 */

import {
  RECORD_FORMS,
  EDITABLE_TYPES,
  coerceFormValues,
  describeRecord,
  formFor,
  hashInput,
  identityParts,
  missingRequired,
  tagSource,
} from '../lib/profile/forms';
import { suite, test, assert } from './harness.mjs';

suite('record form registry', () => {
  test('every form is internally consistent', () => {
    for (const type of EDITABLE_TYPES) {
      const form = RECORD_FORMS[type];
      assert(form.type === type, `${type}: keyed by its own type`);
      assert(form.fields.length > 0, `${type}: has fields`);
      assert(form.identityFields.length > 0, `${type}: has an identity`);

      const names = new Set(form.fields.map((f) => f.name));
      assert(names.size === form.fields.length, `${type}: no duplicate field names`);

      for (const id of form.identityFields) {
        // An identity field that is not a form field hashes to the empty string for
        // every record, so every record of that type collides with every other.
        assert(names.has(id), `${type}: identity field "${id}" is not one of its fields`);
      }

      for (const field of form.fields) {
        if (field.kind === 'select') {
          assert((field.options?.length ?? 0) > 1, `${type}.${field.name}: select needs options`);
        }
        // A required field that is also a select can never be missing, and a required
        // list would be validated as empty-array rather than empty-string.
        if (field.required) assert(field.kind !== 'select', `${type}.${field.name}: select cannot be required`);
      }
    }
  });

  test('a required field left blank is reported by its label', () => {
    const form = formFor('certification')!;
    const missing = missingRequired(form, coerceFormValues(form, { name: 'AWS SAA', issuer: '  ' }));
    assert(missing.length === 1, `expected one gap, got ${missing.join(', ')}`);
    assert(missing[0] === 'Issued by', 'reported by the label the user saw');
  });

  test('a filled form reports nothing missing', () => {
    const form = formFor('education')!;
    const data = coerceFormValues(form, {
      credential: 'B.Sc.',
      institution: 'Anna University',
      field: 'Computer Science',
      startDate: '',
      endDate: '',
    });
    assert(missingRequired(form, data).length === 0, 'both required fields present');
    assert(!('startDate' in data), 'an untouched optional field is omitted, not stored empty');
  });

  test('a list field round-trips through its comma-separated text', () => {
    const form = formFor('project')!;
    const data = coerceFormValues(form, {
      name: 'Resumer AI',
      description: 'Tailored resumes',
      stack: 'Next.js, PostgreSQL,  Drizzle ,',
      links: '',
      impactMetrics: '',
    });
    const stack = data.stack as string[];
    assert(stack.length === 3, `trailing and empty entries dropped, got ${JSON.stringify(stack)}`);
    assert(stack[2] === 'Drizzle', 'and each entry is trimmed');
    assert(Array.isArray(data.links) && (data.links as string[]).length === 0, 'an empty list is an empty array');
  });

  test('identity parts come from the identity fields, in order', () => {
    const form = formFor('volunteering')!;
    const parts = identityParts(form, { role: 'Mentor', organization: 'GDSC' });
    assert(parts.join('|') === 'GDSC|Mentor', `organization then role, got ${parts.join('|')}`);
  });

  test('tagging reads every field, not only the name', () => {
    const form = formFor('project')!;
    const source = tagSource(form, { name: 'Pipeline', stack: ['React', 'Postgres'] });
    assert(source.includes('React') && source.includes('Postgres'), 'stack reaches the tagger');
  });

  test('every type describes itself without falling back to JSON', () => {
    for (const type of EDITABLE_TYPES) {
      const form = RECORD_FORMS[type];
      const data: Record<string, unknown> = {};
      for (const f of form.fields) data[f.name] = f.kind === 'list' ? ['x'] : `${f.name}-value`;
      const line = describeRecord(type, data);
      assert(line.length > 0 && !line.startsWith('{'), `${type}: described as "${line}"`);
    }
  });

  test('a bullet still describes itself, though it has no form', () => {
    assert(formFor('experience-bullet') === null, 'deliberately not in the registry');
    assert(describeRecord('experience-bullet', { text: 'Shipped it' }) === 'Shipped it', 'still readable');
  });
});

suite('hash consistency with the sync', () => {
  test('a hand-typed degree hashes the same as its synced twin', () => {
    // The sync normalises education identity so that one degree spelled several ways is
    // one record. The registry hashed the raw fields, so a degree typed by hand did not
    // collide with the synced row it duplicated and the duplicate check never fired.
    const form = formFor('education')!;
    const typed = hashInput(form, {
      credential: 'M.Sc.',
      field: 'Data Science',
      institution: 'Loyola College',
    });
    const synced = hashInput(form, {
      credential: 'M.Sc. Data Science',
      field: 'Data Science',
      institution: 'Loyola College (Autonomous), Chennai',
    });
    assert(
      typed.join('|') === synced.join('|'),
      `same degree, same hash input — got ${typed.join('|')} vs ${synced.join('|')}`,
    );
  });

  test('two different degrees at one institution still hash apart', () => {
    const form = formFor('education')!;
    const msc = hashInput(form, { credential: 'M.Sc.', field: 'Physics', institution: 'Loyola College' });
    const ma = hashInput(form, { credential: 'M.A.', field: 'History', institution: 'Loyola College' });
    assert(msc.join('|') !== ma.join('|'), 'an M.Sc. and an M.A. are two qualifications');
  });

  test('a certification typed by hand hashes like its synced twin', () => {
    // Certification joined education in hashing a normalised identity rather than its
    // raw fields, because the sync wrote "Nanodegree in Agentic AI" and "Nanodegree,
    // Agentic AI" as two rows. Both routes in must agree or the duplicate check cannot
    // fire between them.
    const form = formFor('certification')!;
    const parts = hashInput(form, { name: 'Nanodegree in Agentic AI', issuer: 'Udacity' });
    assert(parts[0] === 'cert', `the sync's prefix is preserved, got ${parts[0]}`);

    const otherSpelling = hashInput(form, { name: 'Nanodegree, Agentic AI', issuer: 'Udacity' });
    assert(
      parts.join('|') === otherSpelling.join('|'),
      `both spellings hash alike — got ${parts.join('|')} vs ${otherSpelling.join('|')}`,
    );
  });

  test('the same certificate from two issuers still hashes apart', () => {
    const form = formFor('certification')!;
    const a = hashInput(form, { name: 'Introduction to Data Science', issuer: 'Infosys Springboard' });
    const b = hashInput(form, { name: 'Introduction to Data Science', issuer: 'Coursera' });
    assert(a.join('|') !== b.join('|'), 'issuer is part of the identity');
  });

  test('a type with no override still hashes from its identity fields', () => {
    // `award` has neither a hashPrefix nor a hashParts override, so it exercises the
    // default path that every other type still takes.
    const form = formFor('award')!;
    const parts = hashInput(form, { title: 'Hackathon winner', issuer: 'Some Org' });
    assert(parts.join('|') === 'award|Hackathon winner', `got ${parts.join('|')}`);
  });
});

suite('education summary line', () => {
  test('shows the grade, and the field only when the degree does not already say it', () => {
    assert.equal(
      describeRecord('education', { credential: 'B.Sc. Computer Science', field: 'Computer Science', grade: '7.5 / 10', institution: 'Loyola College' }),
      'B.Sc. Computer Science · 7.5 / 10 · Loyola College',
    );
  });
});
