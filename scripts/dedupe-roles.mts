/**
 * One-off cleanup for role rows that accumulated before identity matching existed.
 * Bullets are repointed at the surviving row before any deletion, never orphaned.
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/dedupe-roles.mts
 */
import 'dotenv/config';
import postgres from 'postgres';
import { roleIdentity, mergeRoles, splitMergedTitles, type RoleLike } from '../lib/sync/roles';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const rows = await sql`select id, title, company, location, start_date, end_date from role order by created_at`;
console.log('before:', rows.length, 'role rows');

type Held = RoleLike & { id: string };
const groups = new Map<string, { keep: Held; drop: string[] }>();

for (const r of rows) {
  for (const title of splitMergedTitles(r.title as string)) {
    const key = roleIdentity(r.company as string, title);
    const cand: Held = {
      id: r.id as string,
      title,
      company: r.company as string,
      location: (r.location as string) ?? undefined,
      startDate: (r.start_date as string) ?? '',
      endDate: (r.end_date as string) ?? '',
    };
    const g = groups.get(key);
    if (!g) { groups.set(key, { keep: cand, drop: [] }); continue; }
    groups.set(key, { keep: { ...mergeRoles(g.keep, cand), id: g.keep.id }, drop: [...g.drop, cand.id] });
  }
}

let deleted = 0, repointed = 0;
for (const { keep, drop } of groups.values()) {
  await sql`update role set title=${keep.title}, company=${keep.company},
    location=${keep.location ?? null}, start_date=${keep.startDate}, end_date=${keep.endDate}
    where id=${keep.id}`;
  for (const id of drop) {
    if (id === keep.id) continue;
    const moved = await sql`update profile_record
      set data = jsonb_set(data, '{roleId}', to_jsonb(${keep.id}::text))
      where type='experience-bullet' and data->>'roleId' = ${id} returning id`;
    repointed += moved.length;
    await sql`delete from role where id=${id}`;
    deleted++;
  }
}

const after = await sql`select company, title, location, start_date, end_date from role order by start_date desc`;
console.log(`after : ${after.length} rows | deleted ${deleted} | bullets repointed ${repointed}\n`);
after.forEach((r) => console.log(`  ${r.company} | ${r.title} | ${r.start_date || '(none)'} -> ${r.end_date}`));
await sql.end();
