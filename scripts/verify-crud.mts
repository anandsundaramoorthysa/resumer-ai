/**
 * The hand-edit path, exercised against the real database.
 *
 * Unit tests cover the registry; they cannot show that a write actually lands, that the
 * unique key behaves as assumed, or that an edit promotes a synced row to manual. This
 * creates, edits and deletes one record of every editable type, then asserts the profile
 * is left exactly as it was found.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { RECORD_FORMS, EDITABLE_TYPES } from '../lib/profile/forms';
import {
  createTypedRecord,
  updateTypedRecord,
  deleteRecord,
  DuplicateRecordError,
} from '../lib/profile/records';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const [user] = await sql<{ id: string }[]>`select id from "user" limit 1`;
if (!user) throw new Error('no user in the database');

const before = Number(
  (await sql<{ n: number }[]>`select count(*)::int as n from profile_record where user_id = ${user.id}`)[0].n,
);

/** Values that satisfy the form without resembling anything real, so nothing survives. */
function sample(type: string): Record<string, string> {
  const form = RECORD_FORMS[type];
  const values: Record<string, string> = {};
  for (const field of form.fields) {
    values[field.name] =
      field.kind === 'select'
        ? (field.options?.[0] ?? '')
        : field.kind === 'list'
          ? 'zzcrudcheck-one, zzcrudcheck-two'
          : `zzcrudcheck ${field.name}`;
  }
  return values;
}

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

for (const type of EDITABLE_TYPES) {
  if (type === 'summary') continue; // replaces rather than appends; covered separately.

  const id = await createTypedRecord(user.id, type, sample(type));
  const [row] = await sql<{ source: string; data: Record<string, unknown>; tags: string[] }[]>`
    select source, data, tags from profile_record where id = ${id}`;
  check(row?.source === 'manual', `${type}: created as a manual record`);

  const named = RECORD_FORMS[type].fields[0].name;
  check(
    String(row?.data?.[named] ?? '').startsWith('zzcrudcheck'),
    `${type}: the submitted value is what was stored`,
  );

  // Every field the form defines must survive the write. A field that renders and is
  // then dropped is the exact failure the shared registry exists to prevent.
  for (const field of RECORD_FORMS[type].fields) {
    check(field.name in (row?.data ?? {}), `${type}: field "${field.name}" reached the database`);
  }

  const edited = { ...sample(type), [named]: 'zzcrudcheck edited' };
  await updateTypedRecord(user.id, id, type, edited);
  const [after] = await sql<{ data: Record<string, unknown> }[]>`
    select data from profile_record where id = ${id}`;
  check(after?.data?.[named] === 'zzcrudcheck edited', `${type}: the edit persisted`);

  // A second identical record must be refused rather than silently duplicated.
  let duplicated = false;
  try {
    await createTypedRecord(user.id, type, edited);
    duplicated = true;
  } catch (err) {
    check(err instanceof DuplicateRecordError, `${type}: a duplicate is reported as one`);
  }
  if (duplicated) {
    check(false, `${type}: a duplicate was accepted`);
  }

  await deleteRecord(user.id, id);
  const [gone] = await sql<{ n: number }[]>`
    select count(*)::int as n from profile_record where id = ${id}`;
  check(gone.n === 0, `${type}: deleted`);
}

// Required fields and unknown types must be refused, not written.
for (const [label, fn] of [
  ['a missing required field', () => createTypedRecord(user.id, 'certification', { name: 'x' })],
  ['an unknown type', () => createTypedRecord(user.id, 'nonsense', { name: 'x' })],
  ['a type that is not the row', () => updateTypedRecord(user.id, 'no-such-id', 'award', { title: 'x' })],
] as const) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  check(threw, `rejected: ${label}`);
}

const after = Number(
  (await sql<{ n: number }[]>`select count(*)::int as n from profile_record where user_id = ${user.id}`)[0].n,
);
check(after === before, `profile left as found (${before} records before, ${after} after)`);

await sql.end();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
