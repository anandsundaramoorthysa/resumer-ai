/**
 * DR-4 — the truth check.
 *
 * Every claim on a generated resume must trace to a profile record. This walks the most
 * recent stored document line by line, reports the record each line came from, and
 * checks that every figure it states appears somewhere in the profile. A number on a
 * resume that the profile does not support is the worst failure this system can have —
 * worse than a low score, because the user cannot see it is wrong.
 *
 * The joined-line sections (skills, languages, interests) carry no sourceRecordId by
 * design, since one line is built from many records; those are checked entry by entry
 * instead of being written off.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/verify-grounding.mts <email>
 */
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const E = process.argv[2];
if (!E) {
  console.error('usage: verify-grounding.mts <email>');
  process.exit(1);
}
const [u] = await sql<{ id: string }[]>`select id from "user" where email=${E}`;

const [snap] = await sql<{ document: Record<string, unknown>; score: number }[]>`
  select document, score from resume_snapshot where user_id=${u.id} order by created_at desc limit 1`;

const recs = await sql<{ id: string; type: string; data: Record<string, unknown> }[]>`
  select id, type, data from profile_record where user_id=${u.id}`;
const roles = await sql<{ id: string; title: string; company: string }[]>`
  select id, title, company from "role" where user_id=${u.id}`;
await sql.end();

const byId = new Map(recs.map((r) => [r.id, r]));
const roleById = new Map(roles.map((r) => [r.id, r]));
/** Everything the profile says, as one searchable blob per record. */
const textOf = (r: { data: Record<string, unknown> }) =>
  JSON.stringify(r.data).toLowerCase();
/**
 * Digits and letters only, applied to BOTH sides of every comparison.
 *
 * The first version of this check stripped the comma out of the resume's "50,000" and
 * then searched a profile that still had one — and reported a figure as fabricated that
 * appears in three separate records. Normalise one side only and the check lies.
 */
const digitsOnly = (s: string) => s.replace(/[^0-9a-z]/gi, '').toLowerCase();
const allProfileText = [
  ...recs.map(textOf),
  ...roles.map((r) => `${r.title} ${r.company}`.toLowerCase()),
].join(' ');
const allProfileNorm = digitsOnly(allProfileText);

interface Item { text: string; sourceRecordId: string | null }
interface Section {
  key: string;
  heading: string;
  items: Item[];
  groups?: Array<{ title: string; subtitle?: string; items: Item[] }>;
}
const doc = snap.document as unknown as { sections: Section[] };

const numbersIn = (s: string) => [...s.matchAll(/\b\d[\d,.]*%?\b/g)].map((m) => m[0]);

let total = 0;
let traced = 0;
const untraced: string[] = [];
const invented: string[] = [];

function check(item: Item, where: string) {
  total += 1;
  const src = item.sourceRecordId ? byId.get(item.sourceRecordId) : undefined;
  if (src) traced += 1;
  else untraced.push(`[${where}] ${item.text.slice(0, 90)}`);

  // Any figure stated must appear somewhere in the profile. Checked against the whole
  // profile rather than only the source record, so a correct figure moved between
  // records is not reported as fabricated.
  for (const n of numbersIn(item.text)) {
    if (n.length < 2) continue; // single digits are ordinary prose
    const bare = digitsOnly(n);
    if (!bare) continue;
    if (!allProfileNorm.includes(bare)) {
      invented.push(`[${where}] "${n}" in: ${item.text.slice(0, 80)}`);
    }
  }
}

for (const s of doc.sections) {
  for (const i of s.items) check(i, s.key);
  for (const g of s.groups ?? []) {
    // A group title is a role or project name — it must name a real one.
    const known =
      [...roleById.values()].some((r) => g.title === r.title || g.subtitle === r.company) ||
      recs.some((r) => String(r.data.name ?? '') === g.title);
    if (!known) untraced.push(`[${s.key} GROUP TITLE] ${g.title} / ${g.subtitle ?? ''}`);
    for (const i of g.items) check(i, `${s.key}/${g.title}`);
  }
}

console.log(`snapshot score: ${snap.score}`);
console.log(`resume lines checked: ${total}`);
console.log(`lines traced to a profile record: ${traced}`);
console.log(`\nlines with no source record: ${untraced.length}`);
for (const l of untraced) console.log('   ', l);
console.log(`\nfigures not found anywhere in the profile: ${invented.length}`);
for (const l of invented) console.log('   ', l);

/**
 * The joined-line sections carry no sourceRecordId by design — one line is built from
 * many records — so each comma-separated entry is checked against the profile instead.
 */
console.log('\njoined-line sections, entry by entry:');
for (const s of doc.sections) {
  if (!['skills', 'languages', 'interests'].includes(s.key)) continue;
  for (const item of s.items) {
    const entries = item.text.split(',').map((e) => e.trim()).filter(Boolean);
    const missing = entries.filter((e) => {
      const bare = digitsOnly(e.replace(/\(.*?\)/g, ''));
      return bare.length > 1 && !allProfileNorm.includes(bare);
    });
    console.log(`  ${s.key}: ${entries.length} entries, ${missing.length} not found in the profile`);
    for (const m of missing) console.log('      NOT IN PROFILE:', m);
  }
}
