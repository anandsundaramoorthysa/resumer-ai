/**
 * Re-keys rows the sync never reads — manual, resume import, LinkedIn — from their
 * current data with the current recipe (`hashContent`, `bulletHash`, `hashInput`).
 *
 * For these rows the stored data IS the fact: no parser holds a competing version, and
 * `reconcile` never reads them, so the next sync will not move them across the way it
 * moves synced rows. Their hashes had also drifted before the separator existed — a skill
 * re-filed under a new category kept the hash of its old one — so a hand-typed duplicate
 * was not caught by the unique index. Recomputing from the data is not a guess here; it
 * is the definition.
 *
 * A row whose new hash another row of the same user already holds is a duplicate, and is
 * reported rather than deleted.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/rekey-manual.mts [--apply]
 */

import 'dotenv/config';
import { and, eq, ne } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { profileRecords, roles } from '@/lib/db/schema';
import { bulletHash, hashContent } from '@/lib/sync/reconcile';
import { formFor, hashInput } from '@/lib/profile/forms';

const apply = process.argv.includes('--apply');

const roleRows = await db.select({ id: roles.id, company: roles.company }).from(roles);
const companyOf = new Map(roleRows.map((r) => [r.id, r.company]));
const all = await db
  .select({ id: profileRecords.id, userId: profileRecords.userId, type: profileRecords.type, source: profileRecords.source, data: profileRecords.data, hash: profileRecords.contentHash })
  .from(profileRecords);

const held = new Map(all.map((r) => [`${r.userId}:${r.hash}`, r.id]));
const plan: Array<{ id: string; userId: string; from: string; to: string }> = [];
const clashes: string[] = [];
let current = 0;
let skipped = 0;

for (const r of all) {
  if (r.source === 'github-sync') continue; // moved across by reconcile's identity match
  const d = (r.data ?? {}) as Record<string, unknown>;
  let next: string | null = null;
  if (r.type === 'experience-bullet') {
    const company = companyOf.get(String(d.roleId ?? ''));
    next = company === undefined ? null : bulletHash(company, String(d.text ?? ''));
  } else {
    const form = formFor(r.type);
    next = form ? hashContent(hashInput(form, d)) : null;
  }
  if (!next) {
    skipped += 1;
    continue;
  }
  if (next === r.hash) {
    current += 1;
    continue;
  }
  const holder = held.get(`${r.userId}:${next}`);
  if (holder && holder !== r.id) {
    clashes.push(`${r.type} ${r.id} duplicates ${holder}: ${JSON.stringify(d).slice(0, 80)}`);
    continue;
  }
  held.set(`${r.userId}:${next}`, r.id);
  plan.push({ id: r.id, userId: r.userId, from: r.hash, to: next });
}

console.log(`${plan.length} to re-key, ${current} already current, ${clashes.length} duplicates reported, ${skipped} without a recipe`);
for (const c of clashes) console.log(`  duplicate: ${c}`);

if (!apply) {
  console.log('read-only: run with --apply to write');
  process.exit(0);
}

const backup = `rekey-manual-backup-${Date.now()}.json`;
writeFileSync(process.env.REKEY_BACKUP_DIR ? `${process.env.REKEY_BACKUP_DIR}/${backup}` : backup, JSON.stringify(plan, null, 1));
for (const p of plan) {
  await db
    .update(profileRecords)
    .set({ contentHash: p.to })
    .where(and(eq(profileRecords.id, p.id), eq(profileRecords.userId, p.userId), ne(profileRecords.source, 'github-sync')));
}
console.log(`re-keyed ${plan.length}; previous hashes saved to ${backup}`);
process.exit(0);
