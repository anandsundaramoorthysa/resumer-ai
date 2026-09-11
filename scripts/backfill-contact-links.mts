/**
 * Fills LinkedIn and GitHub on an existing profile from a resume PDF.
 *
 * The extraction gap fixed in lib/import/contact-links.ts applies to future imports.
 * A profile imported before it existed still has the nulls, and re-importing to pick
 * them up would mean re-reviewing every record. This reads the links out of a resume and
 * fills only the empty columns.
 *
 * Dry by default; --apply writes. Never overwrites a value that is already there.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/backfill-contact-links.mts <resume.pdf> [--apply]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { extractUploadText } from '../lib/import/text';
import { findContactLinks } from '../lib/import/contact-links';

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!file) { console.error('usage: backfill-contact-links.mts <resume.pdf> [--apply]'); process.exit(1); }

const { text } = await extractUploadText(readFileSync(file), 'pdf');
const links = findContactLinks(text.slice(0, 1200));
console.log('found in the resume header:', JSON.stringify(links, null, 2));

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
interface ContactRow {
  user_id: string;
  email: string;
  full_name: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  portfolio_url: string | null;
}

const rows = await sql<ContactRow[]>`
  select c.user_id, u.email, c.full_name, c.linkedin_url, c.github_url, c.portfolio_url
  from contact_info c join "user" u on u.id = c.user_id`;

for (const r of rows) {
  const next = {
    linkedin_url: r.linkedin_url || links.linkedinUrl || null,
    github_url: r.github_url || links.githubUrl || null,
    portfolio_url: r.portfolio_url || links.portfolioUrl || null,
  };
  const changed = Object.entries(next).filter(([k, v]) => v !== (r as unknown as Record<string, unknown>)[k]);
  console.log(`\n${r.email} (${r.full_name})`);
  console.log('  before:', JSON.stringify({ linkedin: r.linkedin_url, github: r.github_url, portfolio: r.portfolio_url }));
  if (changed.length === 0) { console.log('  nothing to fill'); continue; }
  console.log('  would set:', changed.map(([k, v]) => `${k}=${v}`).join(', '));
  if (APPLY) {
    await sql`update contact_info set linkedin_url=${next.linkedin_url}, github_url=${next.github_url}, portfolio_url=${next.portfolio_url} where user_id=${r.user_id}`;
    console.log('  applied');
  }
}
if (!APPLY) console.log('\ndry run — pass --apply to write');
await sql.end();
