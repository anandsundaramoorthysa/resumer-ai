/**
 * One-off cleanup for certification rows that accumulated before identity matching
 * existed — the third of its kind, after dedupe-roles and dedupe-education, for the bug
 * described at the top of lib/sync/certifications.ts.
 *
 * The live profile holds "Nanodegree in Agentic AI" and "Nanodegree, Agentic AI", both
 * from Udacity, both `github-sync`. One certificate, written two ways across two passes
 * over the portfolio, hashing two ways because the hash was taken over the raw name.
 *
 * Dry by default, like dedupe-education: nothing is written without --apply, and the
 * plan prints either way. Deleting a row the user might believe is a distinct credential
 * deserves a look before it happens.
 *
 * Records whose `source` is 'manual' are read for context and never written. They are
 * the user's own, and sync — including this script — may not overwrite them (see the
 * comment at the top of lib/profile/records.ts).
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/dedupe-certifications.mts [--apply]
 */
import 'dotenv/config';
import postgres from 'postgres';
// Imported rather than copied. This script had its own transcription of hashContent
// which dropped the `.slice(0, 32)`, so it wrote a 64-character hash where every other
// row carries 32 — meaning the next sync would not recognise the merged row and would
// insert the duplicate again, which is the exact bug this script exists to remove.
import { hashContent } from '../lib/sync/reconcile';
import { recordDedupeAudit } from './dedupe-audit.mjs';
import {
  certificationHashParts,
  certificationIdentity,
  mergeCertifications,
  type CertificationLike,
} from '../lib/sync/certifications';

const APPLY = process.argv.includes('--apply');
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });


interface Row {
  id: string;
  user_id: string;
  source: string;
  content_hash: string;
  data: CertificationLike;
  created_at: Date;
}

const rows = await sql<Row[]>`
  select id, user_id, source, content_hash, data, created_at
  from profile_record
  where type = 'certification'
  order by created_at asc`;

const manual = rows.filter((r) => r.source === 'manual');
const syncable = rows.filter((r) => r.source !== 'manual');

console.log(`before: ${rows.length} certifications (${manual.length} manual, untouched)`);

/** Grouped by normalised identity, oldest first so the surviving row keeps its id. */
const groups = new Map<string, Row[]>();
for (const row of syncable) {
  const key = `${row.user_id}::${certificationIdentity(row.data.name, row.data.issuer ?? '')}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}

const duplicates = [...groups.values()].filter((g) => g.length > 1);

if (duplicates.length === 0) {
  console.log('\nnothing to do — every certification already has a distinct identity');
  await sql.end();
  process.exit(0);
}

console.log(`\nplan${APPLY ? '' : ' (dry run — pass --apply to write)'}:`);

let merged = 0;
let deleted = 0;

for (const group of duplicates) {
  const survivor = group[0];
  const rest = group.slice(1);

  const combined = group.reduce((acc, r) => mergeCertifications(acc, r.data), group[0].data);
  const newHash = hashContent(certificationHashParts(combined));

  console.log(`  merge ${group.length} rows into one`);
  for (const r of group) {
    console.log(`    - ${r.data.name} | ${r.data.issuer}${r.id === survivor.id ? '   (kept)' : ''}`);
  }
  console.log(`    = ${combined.name} | ${combined.issuer}`);

  if (APPLY) {
    await sql.begin(async (tx) => {
      await tx`
        update profile_record
        set data = ${tx.json(combined as unknown as Parameters<typeof tx.json>[0])},
            content_hash = ${newHash},
            updated_at = now()
        where id = ${survivor.id}`;
      await tx`delete from profile_record where id in ${tx(rest.map((r) => r.id))}`;

      // Written inside the transaction so the trace lands or rolls back with the change.
      // Without it a row simply vanishes: a reviewer lost real time to a profile that
      // went 172 -> 171 with nothing in audit_log to account for it.
      await recordDedupeAudit(tx as never, 'github-sync', [
        {
          userId: survivor.user_id,
          recordId: survivor.id,
          action: 'update',
          diff: {
            reason: 'absorbed duplicate certifications',
            absorbed: rest.map((r) => ({ id: r.id, name: r.data.name })),
            result: { name: combined.name, issuer: combined.issuer },
            script: 'dedupe-certifications',
          },
        },
        ...rest.map((r) => ({
          userId: r.user_id,
          recordId: r.id,
          action: 'delete' as const,
          diff: {
            reason: 'duplicate certification merged into another row',
            mergedInto: survivor.id,
            removed: { name: r.data.name, issuer: r.data.issuer },
            script: 'dedupe-certifications',
          },
        })),
      ]);
    });
    merged += 1;
    deleted += rest.length;
  }
}

if (APPLY) {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from profile_record where type = 'certification'`;
  console.log(`\napplied: merged ${merged}, deleted ${deleted}`);
  console.log(`after: ${n} certifications`);
} else {
  console.log(`\n${duplicates.length} group(s) would be merged. Nothing written.`);
}

await sql.end();
