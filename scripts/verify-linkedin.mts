/**
 * The LinkedIn import, end to end against the real database.
 *
 * The unit tests stop at the preview. This runs the rest: a synthesised export is zipped,
 * read back through the same reader the route uses, committed exactly as the review
 * screen would commit it, and then inspected as stored rows. Everything it created is
 * deleted afterwards by id — the ids are diffed before and after rather than matched by
 * content, so a row that already belonged to the user cannot be caught in the cleanup.
 */
import 'dotenv/config';
import { deflateRawSync } from 'node:zlib';
import postgres from 'postgres';
import { readZip } from '../lib/import/zip';
import { buildLinkedInPreview } from '../lib/import/linkedin';
import { commitImport } from '../lib/import/commit';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const [user] = await sql<{ id: string }[]>`select id from "user" limit 1`;
if (!user) throw new Error('no user in the database');

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

/* A minimal but realistic export, with the awkward parts: a comma and a newline inside
   a quoted description, one job written twice, and one job with no description. */
const FILES: Array<[string, string]> = [
  [
    'Positions.csv',
    'Company Name,Title,Description,Location,Started On,Finished On\n' +
      'ZZ Check Labs,Platform Engineer,"• Rebuilt the ingest path, cutting cost 30%\n' +
      '• Ran it for 12 teams",Remote,Jan 2025,Mar 2025\n' +
      'ZZ Check Labs,Platform Engineer,"• Rebuilt the ingest path, cutting cost 30%",Remote,Jan 2025,Mar 2025\n' +
      'ZZ Quiet Co,Analyst,,Chennai,Feb 2024,Apr 2024\n',
  ],
  ['Skills.csv', 'Name\nZZCheckLang\n'],
  ['Languages.csv', 'Name,Proficiency\nZZCheckTongue,Native or bilingual proficiency\n'],
  ['Honors.csv', 'Title,Description,Issued On\nZZ Check Prize,For the check,Aug 2025\n'],
];

function makeZip(files: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8');
    const body = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

const contents = new Map<string, string>();
for (const entry of readZip(makeZip(FILES))) {
  contents.set(entry.name, entry.bytes.toString('utf8'));
}
const preview = buildLinkedInPreview(contents);
check(preview.totalCount > 0, `preview produced ${preview.totalCount} candidates`);

const recordIdsBefore = new Set(
  (await sql<{ id: string }[]>`select id from profile_record where user_id = ${user.id}`).map((r) => r.id),
);
const roleIdsBefore = new Set(
  (await sql<{ id: string }[]>`select id from "role" where user_id = ${user.id}`).map((r) => r.id),
);

// Exactly what the review screen sends when everything is left ticked.
const payload = {
  contact: null,
  roles: preview.roles.map((role) => ({
    title: role.title,
    company: role.company,
    startDate: role.startDate,
    endDate: role.endDate,
    bullets: role.bullets.map((b) => ({
      text: String(b.record.text ?? ''),
      action: String(b.record.action ?? ''),
      tags: (b.record.tags as string[]) ?? [],
    })),
  })),
  records: preview.records.map((c) => {
    const { contentHash: _h, source: _s, ...rest } = c.record;
    void _h;
    void _s;
    return rest as Record<string, unknown>;
  }),
};

const summary = await commitImport(user.id, payload as never, 'linkedin');
console.log('   ', summary.message);
check(summary.unreadable === 0, 'every proposed record was storable');

const created = await sql<{ id: string; type: string; source: string; data: Record<string, unknown> }[]>`
  select id, type, source, data from profile_record where user_id = ${user.id}`;
const newRecords = created.filter((r) => !recordIdsBefore.has(r.id));
const newRoles = (
  await sql<{ id: string; company: string; title: string }[]>`
    select id, company, title from "role" where user_id = ${user.id}`
).filter((r) => !roleIdsBefore.has(r.id));

check(newRecords.length === summary.created, `${summary.created} new rows, ${newRecords.length} found`);
check(
  newRecords.every((r) => r.source === 'linkedin'),
  'every new row is stamped linkedin, so no sync will overwrite it',
);
check(newRoles.length === 2, `both jobs became roles, got ${newRoles.length}`);
check(
  newRoles.some((r) => r.company === 'ZZ Quiet Co'),
  'the job with no description is still a role, so the profile page can prompt for its accomplishments',
);

const bullets = newRecords.filter((r) => r.type === 'experience-bullet');
check(bullets.length === 2, `two bullets from the description, got ${bullets.length}`);
check(
  bullets.some((b) => String(b.data.text) === 'Rebuilt the ingest path, cutting cost 30%'),
  'the comma inside the quoted description did not split the row',
);
check(
  bullets.every((b) => newRoles.some((role) => role.id === String(b.data.roleId))),
  'every bullet points at a real role row, so none is orphaned at assembly time',
);

// Re-importing the same export must add nothing.
const again = await commitImport(user.id, payload as never, 'linkedin');
check(again.created === 0, `a second import of the same export added ${again.created} rows`);

// --- cleanup, by id ---------------------------------------------------------------
const recordIds = newRecords.map((r) => r.id);
const roleIds = newRoles.map((r) => r.id);
if (recordIds.length) await sql`delete from profile_record where id in ${sql(recordIds)}`;
if (roleIds.length) await sql`delete from "role" where id in ${sql(roleIds)}`;

const [{ n: recordsNow }] = await sql<{ n: number }[]>`
  select count(*)::int as n from profile_record where user_id = ${user.id}`;
check(recordsNow === recordIdsBefore.size, `profile left as found (${recordIdsBefore.size} records)`);

await sql.end();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
