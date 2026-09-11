/**
 * One-off cleanup for the education rows that accumulated before identity matching
 * existed — the mirror of scripts/dedupe-roles.mts, for the bug described at the top of
 * lib/sync/education.ts.
 *
 * It does two things: collapses every education row that is one qualification told
 * several ways into a single row carrying the fullest strings and the merged dates, and
 * moves a misfiled certificate ("Certification in Hindi Proficiency") into the
 * certifications it belongs with.
 *
 * Unlike dedupe-roles this one is dry by default. That script rewrote rows the moment it
 * was run, which is defensible for a repointing pass and much less so for one that
 * deletes qualifications and rewrites a record's type — so nothing is written without
 * --apply, and the plan is printed either way.
 *
 * Records whose `source` is 'manual' are read for context and never written: they are
 * the user's own, and sync — including this script — may not overwrite them (see the
 * comment at the top of lib/profile/records.ts).
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/dedupe-education.mts [--apply]
 */
import { recordDedupeAudit } from './dedupe-audit.mjs';
import 'dotenv/config';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import {
  educationHashParts,
  educationIdentity,
  looksLikeCertification,
  mergeEducation,
  type EducationLike,
} from '../lib/sync/education';

/** Same recipe as lib/sync/reconcile.ts, inlined so this script pulls in no server-only code. */
function hashContent(parts: Array<string | undefined>): string {
  return createHash('sha256')
    .update(parts.filter(Boolean).join('').toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 32);
}

const apply = process.argv.includes('--apply');
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

interface Row {
  id: string;
  user_id: string;
  source: string;
  content_hash: string;
  data: Record<string, unknown>;
}

const total = await sql<{ n: number }[]>`select count(*)::int as n from profile_record`;
const rows = await sql<Row[]>`
  select id, user_id, source, content_hash, data
  from profile_record where type = 'education' order by created_at`;

const manual = rows.filter((r) => r.source === 'manual');
const synced = rows.filter((r) => r.source !== 'manual');

console.log(`before: ${total[0].n} profile records, ${rows.length} of them education`);
console.log(`        ${manual.length} manual (untouched), ${synced.length} synced\n`);

const asEducation = (r: Row): EducationLike => ({
  institution: String(r.data.institution ?? ''),
  credential: String(r.data.credential ?? ''),
  field: (r.data.field as string | undefined) ?? undefined,
  startDate: (r.data.startDate as string | undefined) ?? undefined,
  endDate: (r.data.endDate as string | undefined) ?? undefined,
});

/* ------------------------------------------------------- plan: misfiled certs -- */

const toCertify: Array<{ row: Row; name: string; issuer: string; issuedDate?: string; hash: string }> = [];
const degrees: Row[] = [];

for (const row of synced) {
  const cert = looksLikeCertification(asEducation(row));
  if (!cert) {
    degrees.push(row);
    continue;
  }
  toCertify.push({ ...cert, row, hash: hashContent(['cert', cert.name, cert.issuer]) });
}

// A certification the user already holds under that exact name and issuer would collide
// on (user_id, content_hash). Then the education row is a duplicate of a good record
// rather than the only copy, and the right move is to drop it, not to rewrite it.
const existingCertHashes = new Set(
  (
    await sql<{ content_hash: string; user_id: string }[]>`
      select content_hash, user_id from profile_record where type = 'certification'`
  ).map((r) => `${r.user_id}:${r.content_hash}`),
);

/* --------------------------------------------------------- plan: duplicates ---- */

interface Group {
  keep: Row;
  merged: EducationLike;
  drop: Row[];
}

const groups = new Map<string, Group>();
for (const row of degrees) {
  const item = asEducation(row);
  const identity = `${row.user_id}::${educationIdentity(item.institution, item.credential, item.field)}`;
  const group = groups.get(identity);
  if (!group) {
    groups.set(identity, { keep: row, merged: item, drop: [] });
    continue;
  }
  group.merged = mergeEducation(group.merged, item);
  group.drop.push(row);
}

const describe = (e: EducationLike) =>
  `${e.credential} | ${e.field ?? '—'} | ${e.institution} | ${e.startDate ?? '(none)'} -> ${e.endDate ?? '(none)'}`;

console.log(apply ? 'applying:' : 'plan (dry run — pass --apply to write):');

let willDelete = 0;
for (const group of groups.values()) {
  if (group.drop.length === 0) continue;
  console.log(`\n  merge ${group.drop.length + 1} rows into one`);
  for (const row of [group.keep, ...group.drop]) console.log(`    - ${describe(asEducation(row))}`);
  console.log(`    = ${describe(group.merged)}`);
  console.log(`    keeping ${group.keep.id}, deleting ${group.drop.map((r) => r.id).join(', ')}`);
  willDelete += group.drop.length;
}

for (const c of toCertify) {
  const collides = existingCertHashes.has(`${c.row.user_id}:${c.hash}`);
  console.log(`\n  reclassify education -> certification`);
  console.log(`    - ${describe(asEducation(c.row))}`);
  console.log(`    = ${c.name} | ${c.issuer} | ${c.issuedDate ?? '(no date)'}`);
  console.log(collides ? `    already a certification — deleting the education row` : `    hash ${c.hash}`);
  if (collides) willDelete += 1;
}

if (willDelete === 0 && toCertify.length === 0) {
  console.log('\n  nothing to do.');
}

/* ----------------------------------------------------------------- apply ------ */

let deleted = 0;
let merged = 0;
let reclassified = 0;

if (apply) {
  // One transaction: a half-applied cleanup leaves a degree deleted with nothing
  // holding its dates.
  await sql.begin(async (tx) => {
    for (const group of groups.values()) {
      if (group.drop.length === 0) continue;
      const { merged: m } = group;
      // The surviving row is re-hashed over the normalised identity, which is what the
      // parser now writes — otherwise the next sync sees an unknown hash and inserts a
      // fresh copy of the degree this pass just merged.
      await tx`
        update profile_record set
          data = ${{
            institution: m.institution,
            credential: m.credential,
            ...(m.field ? { field: m.field } : {}),
            ...(m.startDate ? { startDate: m.startDate } : {}),
            ...(m.endDate ? { endDate: m.endDate } : {}),
            source: 'github-sync',
          } as never},
          content_hash = ${hashContent(educationHashParts(m))},
          tags = ${[m.credential.toLowerCase(), m.field?.toLowerCase() ?? ''].filter(Boolean) as never},
          updated_at = now()
        where id = ${group.keep.id} and source <> 'manual'`;
      merged += 1;

      for (const row of group.drop) {
        const gone = await tx`delete from profile_record where id = ${row.id} and source <> 'manual' returning id`;
        deleted += gone.length;

        // Recorded inside the transaction, so the trace lands or rolls back with the
        // deletion it describes. Without this a row simply disappears: an engineer
        // reviewing this project lost real time to a profile that went 172 -> 171 with
        // nothing in audit_log to explain it.
        if (gone.length > 0) {
          await recordDedupeAudit(tx as never, 'github-sync', [
            {
              userId: row.user_id,
              recordId: row.id,
              action: 'delete',
              diff: {
                reason: 'merged into a duplicate education record',
                mergedInto: group.keep.id,
                removed: { credential: row.data?.credential, institution: row.data?.institution },
                survivor: { credential: m.credential, institution: m.institution },
                script: 'dedupe-education',
              },
            },
          ]);
        }
      }
    }

    for (const c of toCertify) {
      if (existingCertHashes.has(`${c.row.user_id}:${c.hash}`)) {
        const gone = await tx`delete from profile_record where id = ${c.row.id} and source <> 'manual' returning id`;
        deleted += gone.length;
        continue;
      }
      await tx`
        update profile_record set
          type = 'certification',
          data = ${{
            name: c.name,
            issuer: c.issuer,
            ...(c.issuedDate ? { issuedDate: c.issuedDate } : {}),
            source: 'github-sync',
          } as never},
          content_hash = ${c.hash},
          tags = ${[c.name.toLowerCase()] as never},
          updated_at = now()
        where id = ${c.row.id} and source <> 'manual'`;
      reclassified += 1;
    }
  });
}

/* ----------------------------------------------------------------- report ----- */

const afterTotal = await sql<{ n: number }[]>`select count(*)::int as n from profile_record`;
const after = await sql<Row[]>`
  select id, user_id, source, content_hash, data
  from profile_record where type in ('education', 'certification') order by type, created_at`;

const afterEducation = after.filter((r) => 'credential' in r.data);
console.log(
  `\nafter : ${afterTotal[0].n} profile records, ${afterEducation.length} education` +
    ` | merged ${merged} | deleted ${deleted} | reclassified ${reclassified}` +
    (apply ? '' : ' (dry run — nothing written)'),
);
for (const r of afterEducation) console.log(`  education    ${describe(asEducation(r))}`);
for (const r of after.filter((x) => !afterEducation.includes(x))) {
  console.log(`  certification ${r.data.name} | ${r.data.issuer}${r.data.issuedDate ? ` | ${r.data.issuedDate}` : ''}`);
}

await sql.end();
