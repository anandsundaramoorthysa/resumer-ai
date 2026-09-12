/**
 * Runs the "find numbers for these lines" paths against a real stored profile, in process,
 * READ-ONLY.
 *
 * Nothing is written: the library functions are called directly rather than through the
 * server actions, so neither the bullets nor the enrichment queue are touched. What it
 * prints is the whole point of the feature — what was searched, which pages were kept as
 * this person and why, every verified quote, each bullet before and after, and every
 * rewrite the grounding guard refused.
 *
 * Run:  DOTENV_CONFIG_PATH=../.env npx tsx scripts/verify-employer-context.mts <email> [company-filter] [company-url]
 *
 * Without a URL it runs the primary path (the user's own published words); with one, the
 * employer-context path against that page.
 */

import 'dotenv/config';

import { eq } from 'drizzle-orm';
import { db } from '../lib/db';
import { contactInfo, profileRecords, roles as rolesTable, users } from '../lib/db/schema';
import { DraftBudget } from '../lib/ai/budget';
import { missingBulletParts } from '../lib/profile/enrichment';
import { researchEmployer, type RewriteProposal, type RoleBullet } from '../lib/profile/employer-context';
import { findSelfEvidence } from '../lib/profile/self-evidence';
import type { ProfileRecord } from '../lib/types';

function printProposals(proposals: RewriteProposal[]) {
  for (const p of proposals) {
    console.log(`\n  before: ${p.before}`);
    console.log(`  after : ${p.after ?? '(nothing offered, or refused)'}`);
    if (p.violations.length) {
      console.log(`  refused: ${p.violations.map((v) => `${v.kind}:${v.token}`).join(', ')}`);
    }
    if (p.question) console.log(`  question: ${p.question}`);
  }
}

async function main() {
  const email = (process.argv[2] ?? '').toLowerCase();
  const only = (process.argv[3] ?? '').toLowerCase();
  const url = process.argv[4] ?? '';
  if (!email) throw new Error('Pass the account email.');

  const all = await db.select({ id: users.id, email: users.email }).from(users);
  const user = all.find((u) => (u.email ?? '').toLowerCase() === email);
  if (!user) throw new Error(`No account for ${email}`);

  const [contact] = await db.select().from(contactInfo).where(eq(contactInfo.userId, user.id)).limit(1);
  const roles = await db.select().from(rolesTable).where(eq(rolesTable.userId, user.id));
  const records = await db.select().from(profileRecords).where(eq(profileRecords.userId, user.id));

  for (const role of roles.filter(
    (r) => r.reviewState === 'approved' && (!only || r.company.toLowerCase().includes(only)),
  )) {
    const bullets: RoleBullet[] = records
      .filter((r) => r.type === 'experience-bullet' && !r.flaggedForRemoval)
      .filter((r) => String((r.data as Record<string, unknown>).roleId ?? '') === role.id)
      .map((r) => {
        const data = r.data as Record<string, unknown>;
        return {
          recordId: r.id,
          text: String(data.text ?? data.action ?? ''),
          missing: missingBulletParts({ ...(data as object), id: r.id, type: 'experience-bullet' } as ProfileRecord),
        };
      });
    if (bullets.length === 0) continue;

    console.log(`\n=== ${role.title} at ${role.company} — ${bullets.length} bullets`);
    const budget = new DraftBudget({ maxCalls: 2, maxTokens: 60_000 }, 24_000, 1_000);
    const role2 = { title: role.title, company: role.company };

    if (url) {
      const context = await researchEmployer({ role: role2, bullets, url, budget });
      console.log(context.source.ok ? `  read: ${context.source.url}` : `  no page: ${context.source.message}`);
      for (const fact of context.facts) console.log(`  company fact: ${fact}`);
      printProposals(context.proposals);
    } else {
      const found = await findSelfEvidence({ fullName: contact?.fullName ?? '', role: role2, bullets, budget });
      console.log(`  searched: ${found.query}`);
      if (found.note) console.log(`  note: ${found.note}`);
      found.sources.forEach((s, i) => {
        console.log(`  source ${i}: ${s.domain} — kept because: …${s.tie.slice(0, 160)}…`);
        for (const f of found.facts.filter((f) => f.source === i)) console.log(`    quote: "${f.quote}"`);
      });
      printProposals(found.proposals);
    }
    console.log(`  spend: ${JSON.stringify(budget.snapshot())}`);
  }
  process.exit(0);
}

void main();
