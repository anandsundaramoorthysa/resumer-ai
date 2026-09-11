/**
 * Moves stored experience bullets onto the one bullet identity (`bulletHash` in
 * lib/sync/reconcile.ts): the job's company and the sentence.
 *
 * Hand-written bullets were hashed with their role's row id, so the same sentence typed
 * by hand and imported was never recognised as one. New writes use the shared recipe;
 * this brings existing rows onto it.
 *
 * Read-only unless `--apply`. A row whose new hash another row already holds is a real
 * duplicate and is only reported — deleting someone's data is their decision, and the
 * profile steward's duplicate check will offer the merge.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/rehash-bullets.mts [--apply]
 */

import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { profileRecords, roles } from '@/lib/db/schema';
import { bulletHash } from '@/lib/sync/reconcile';

const apply = process.argv.includes('--apply');

const bullets = await db
  .select({ id: profileRecords.id, userId: profileRecords.userId, hash: profileRecords.contentHash, data: profileRecords.data })
  .from(profileRecords)
  .where(eq(profileRecords.type, 'experience-bullet'));
const companyOf = new Map(
  (await db.select({ id: roles.id, company: roles.company }).from(roles)).map((r) => [r.id, r.company]),
);
const held = new Set(bullets.map((b) => `${b.userId}:${b.hash}`));

let current = 0;
let orphaned = 0;
const moves: Array<{ id: string; userId: string; hash: string }> = [];
const clashes: string[] = [];

for (const b of bullets) {
  const data = b.data as { roleId?: string; text?: string };
  const company = data.roleId ? companyOf.get(data.roleId) : undefined;
  if (company === undefined) {
    orphaned += 1;
    continue;
  }
  const hash = bulletHash(company, String(data.text ?? ''));
  if (hash === b.hash) {
    current += 1;
  } else if (held.has(`${b.userId}:${hash}`)) {
    clashes.push(`${b.id} — "${String(data.text ?? '').slice(0, 70)}" at ${company}`);
  } else {
    moves.push({ id: b.id, userId: b.userId, hash });
    held.add(`${b.userId}:${hash}`);
  }
}

console.log(`${bullets.length} bullets: ${current} already current, ${moves.length} to re-hash, ${clashes.length} duplicates of another row, ${orphaned} with no job`);
for (const c of clashes) console.log(`  duplicate: ${c}`);

if (apply) {
  for (const m of moves) {
    await db
      .update(profileRecords)
      .set({ contentHash: m.hash })
      .where(and(eq(profileRecords.id, m.id), eq(profileRecords.userId, m.userId)));
  }
  console.log(`re-hashed ${moves.length}`);
} else if (moves.length > 0) {
  console.log('read-only: run with --apply to re-hash');
}
process.exit(0);
