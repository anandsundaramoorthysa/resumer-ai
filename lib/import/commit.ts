/**
 * Writing confirmed import candidates into the profile — task 2.3, REQ-1.2, REQ-10.1.
 *
 * Nothing reaches `profile_record` until the user has ticked it. That is the whole point
 * of the review step: an AI pass over someone's old resume is a proposal, not a fact, and
 * the profile is the thing every generated bullet is checked against.
 *
 * The payload arrives from the browser, so it is re-validated here and every content hash
 * is recomputed server-side. A hash the client supplied would let a stale or edited
 * candidate collide with an existing record and silently overwrite the reconciliation
 * key that REQ-2.4 depends on.
 */

import 'server-only';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { auditLog, contactInfo, profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { audit } from '@/lib/server/profile';
import { bulletHash, hashContent } from '@/lib/sync/reconcile';
import { formFor, hashInput, missingRequired, tagSource } from '@/lib/profile/forms';
import { deriveTags } from '@/lib/sync/tags';
import { roleIdentity } from '@/lib/sync/roles';
import type { RecordSource } from '@/lib/types';
import { tidyRecordData, tidyText } from '@/lib/steward/tidy';
import { fillContactGaps, type ContactFields } from './contact-links';

const Tags = z.array(z.string().max(64)).max(50).default([]);

const BulletIn = z.object({
  text: z.string().min(1).max(2000),
  action: z.string().max(2000).default(''),
  scale: z.string().max(500).optional(),
  outcome: z.string().max(1000).optional(),
  tags: Tags,
});

const RoleIn = z.object({
  title: z.string().min(1).max(200),
  company: z.string().max(200).default(''),
  startDate: z.string().max(32).default(''),
  endDate: z.string().max(32).default('present'),
  bullets: z.array(BulletIn).max(60).default([]),
});

/**
 * A record arrives as its type plus whatever fields that type has.
 *
 * This was a hand-written discriminated union of five types, which is why importing a
 * resume could never bring in a publication, award, language or volunteering role even
 * though the extractor produced them — the schema silently dropped what it did not
 * name. The field list now comes from lib/profile/forms.ts, the same registry the
 * profile editor uses, so a type is importable exactly when it is editable.
 */
const RecordIn = z.looseObject({
  type: z.string().min(1),
  tags: Tags,
});

/**
 * Keeps only the fields the type actually declares, coerced to their declared shape.
 *
 * The payload comes from the browser, so an unrecognised key is not stored: a record's
 * `data` is read back untyped by the assembler, and one stray field there is a value
 * that appears on a resume having never passed any check.
 */
function sanitize(
  type: string,
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const form = formFor(type);
  if (!form) return null;

  const data: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = raw[field.name];
    if (field.kind === 'list') {
      data[field.name] = Array.isArray(value)
        ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => String(v).trim())
        : [];
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      data[field.name] = field.maxLength ? value.trim().slice(0, field.maxLength) : value.trim();
    }
  }

  const tidy = tidyRecordData(type, data);
  if (missingRequired(form, tidy).length > 0) return null;
  return tidy;
}

export const CommitPayloadSchema = z.object({
  contact: z
    .object({
      fullName: z.string().default(''),
      email: z.string().default(''),
      phone: z.string().optional(),
      location: z.string().optional(),
      portfolioUrl: z.string().optional(),
      githubUrl: z.string().optional(),
      linkedinUrl: z.string().optional(),
    })
    .nullable()
    .optional(),
  // Bounded so a payload cannot be used as unmetered storage, and so one commit fits one
  // request: a server action refuses a body over 1 MB, which 2,000 records of 2,000
  // characters never would have. A real resume yields tens of records; a large LinkedIn
  // export a few hundred.
  roles: z.array(RoleIn).max(100).default([]),
  records: z.array(RecordIn).max(600).default([]),
});

export type CommitPayload = z.infer<typeof CommitPayloadSchema>;

export interface CommitSummary {
  created: number;
  duplicates: number;
  rolesCreated: number;
  contactUpdated: boolean;
  /** Selected entries that carried no usable content and were skipped. */
  unreadable: number;
  message: string;
}

/**
 * Which stored job each incoming role is, or that it is new. Pure, so it is tested.
 *
 * Matched on the normalised company-and-title identity the sync already uses, not only on
 * the exact hash: "2022-01" against "2022", "Acme Inc." against "Acme", or a missing start
 * date each made a second copy of a job the profile already had — the "16 rows for 9
 * jobs" bug, fixed for the sync and brought back by every import.
 */
export function resolveRoles(
  stored: Array<{ id: string; contentHash: string; company: string; title: string }>,
  incoming: Array<{ company: string; title: string; startDate: string }>,
): { targets: Array<{ existingId: string } | { newIndex: number }>; fresh: number[] } {
  const byHash = new Map(stored.map((r) => [r.contentHash, r.id]));
  const byIdentity = new Map(stored.map((r) => [roleIdentity(r.company, r.title), r.id]));
  const newByIdentity = new Map<string, number>();
  const fresh: number[] = [];

  const targets = incoming.map((role, i) => {
    const hash = hashContent(['role', role.company, role.title, role.startDate]);
    const identity = roleIdentity(role.company, role.title);
    const existingId = byHash.get(hash) ?? byIdentity.get(identity);
    if (existingId) return { existingId };
    const seen = newByIdentity.get(identity);
    if (seen !== undefined) return { newIndex: seen };
    newByIdentity.set(identity, i);
    fresh.push(i);
    return { newIndex: i };
  });
  return { targets, fresh };
}

interface RowIn {
  type: string;
  contentHash: string;
  tags: string[];
  data: Record<string, unknown>;
}

export async function commitImport(
  userId: string,
  payload: CommitPayload,
  /** Provenance for everything written, so REQ-1.2 stays truthful per source. */
  source: RecordSource = 'ai-import',
): Promise<CommitSummary> {
  // Every write below is batched. This made one or two round trips per record — about 120
  // statements for a 60-record resume at a quarter of a second each, past the 30-second
  // function limit, leaving some rows written and no summary. The sync measured the same
  // shape at 34s for 150 records before it was batched (lib/server/profile.ts).
  const roles = payload.roles.map((raw) => ({
    ...raw,
    title: tidyText(raw.title),
    company: tidyText(raw.company),
    bullets: raw.bullets.map((b) => ({
      ...b,
      text: tidyText(b.text),
      action: tidyText(b.action),
      scale: b.scale && tidyText(b.scale),
      outcome: b.outcome && tidyText(b.outcome),
    })),
  }));

  // --- Roles first: a bullet's roleId must be a real row id, or the assembler has
  // nothing to group it under and it renders as a loose line with no employer.
  const stored = roles.length
    ? await db
        .select({ id: rolesTable.id, contentHash: rolesTable.contentHash, company: rolesTable.company, title: rolesTable.title })
        .from(rolesTable)
        // A job the user rejected is not one to file new bullets under — they would be
        // invisible, under a role no draft loads.
        .where(and(eq(rolesTable.userId, userId), ne(rolesTable.reviewState, 'rejected')))
    : [];
  const { targets, fresh } = resolveRoles(stored, roles);

  const newIds = new Map<number, string>();
  if (fresh.length > 0) {
    const inserted = await db
      .insert(rolesTable)
      .values(
        fresh.map((i) => ({
          userId,
          title: roles[i].title,
          company: roles[i].company,
          startDate: roles[i].startDate,
          endDate: roles[i].endDate || 'present',
          source,
          contentHash: hashContent(['role', roles[i].company, roles[i].title, roles[i].startDate]),
        })),
      )
      .returning({ id: rolesTable.id });
    fresh.forEach((i, n) => newIds.set(i, inserted[n].id));
  }

  const companyOf = new Map(stored.map((r) => [r.id, r.company]));
  const rows: RowIn[] = [];
  roles.forEach((role, i) => {
    const target = targets[i];
    const roleId = 'existingId' in target ? target.existingId : newIds.get(target.newIndex)!;
    // Hashed under the company as the matched job spells it, so the same bullet imported
    // again from a resume that writes "Acme" instead of "Acme Inc." is recognised.
    const company = 'existingId' in target ? (companyOf.get(roleId) ?? role.company) : roles[target.newIndex].company;
    for (const bullet of role.bullets) {
      rows.push({
        type: 'experience-bullet',
        contentHash: bulletHash(company, bullet.text),
        // Derived here, like every other writer. The browser's tags were stored as sent,
        // and tags decide which job keywords a resume is allowed to claim.
        tags: deriveTags(bullet.text),
        data: {
          roleId,
          text: bullet.text,
          // A bullet split into parts keeps its action; otherwise the action is the text.
          // Taking a suggested rewrite used to change `text` and leave the old `action`,
          // which the evidence grader reads.
          action: bullet.scale || bullet.outcome ? bullet.action || bullet.text : bullet.text,
          scale: bullet.scale,
          outcome: bullet.outcome,
        },
      });
    }
  });

  let unreadable = 0;
  for (const rec of payload.records) {
    const data = sanitize(rec.type, rec as Record<string, unknown>);
    if (!data) {
      // A type with no form, or one missing a required field, is counted and reported
      // rather than dropped in silence: "nothing added" with no reason is the worst
      // possible end to a review the user just spent time on.
      unreadable += 1;
      continue;
    }
    const form = formFor(rec.type)!;
    rows.push({
      type: rec.type,
      contentHash: hashContent(hashInput(form, data)),
      tags: deriveTags(tagSource(form, data)),
      data,
    });
  }

  const created = await insertRecords(userId, rows, source);
  const contactUpdated = await writeContact(userId, payload.contact ?? null, source);
  const duplicates = rows.length - created;
  const rolesCreated = fresh.length;

  return {
    created,
    duplicates,
    rolesCreated,
    contactUpdated,
    unreadable,
    message: summarize(created, duplicates, rolesCreated, contactUpdated, unreadable),
  };
}

/**
 * Inserts what is not already in the profile and returns how many rows landed. The unique
 * index on (userId, contentHash) is what makes re-importing the same file safe: a second
 * import adds nothing rather than duplicating a career. Each chunk and its audit rows
 * (REQ-10.1) commit together, so a record never exists without the row naming its source.
 */
async function insertRecords(userId: string, rows: RowIn[], source: RecordSource): Promise<number> {
  const unique = [...new Map(rows.map((r) => [r.contentHash, r])).values()];
  let created = 0;
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    created += await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(profileRecords)
        .values(chunk.map((r) => ({ userId, source, type: r.type, contentHash: r.contentHash, tags: r.tags, data: r.data })))
        .onConflictDoNothing()
        .returning({ id: profileRecords.id, type: profileRecords.type, contentHash: profileRecords.contentHash });
      if (inserted.length > 0) {
        await tx.insert(auditLog).values(
          inserted.map((r) => ({
            userId,
            recordId: r.id,
            action: 'create',
            source,
            diff: { type: r.type, contentHash: r.contentHash },
          })),
        );
      }
      return inserted.length;
    });
  }
  return created;
}

/**
 * Contact details fill gaps rather than overwrite (see `fillContactGaps`). Shared with the
 * portfolio sync. Returns whether anything was written.
 */
export async function writeContact(
  userId: string,
  contact: Partial<Record<keyof ContactFields, string | null | undefined>> | null | undefined,
  source: RecordSource,
): Promise<boolean> {
  if (!contact) return false;

  const [existing] = await db
    .select()
    .from(contactInfo)
    .where(eq(contactInfo.userId, userId))
    .limit(1);

  const { merged, changed } = fillContactGaps(existing, contact);
  if (!changed) return false;

  await db
    .insert(contactInfo)
    .values({ userId, ...merged })
    .onConflictDoUpdate({ target: contactInfo.userId, set: merged });

  await audit(userId, null, 'update', source, { contact: true });
  return true;
}

function summarize(
  created: number,
  duplicates: number,
  rolesCreated: number,
  contactUpdated: boolean,
  unreadable: number,
): string {
  if (created === 0 && !contactUpdated && rolesCreated === 0) {
    if (unreadable > 0) {
      return `${unreadable} selected entr${unreadable === 1 ? 'y was' : 'ies were'} incomplete and could not be saved.`;
    }
    return duplicates > 0
      ? `Everything selected was already in your profile — nothing added.`
      : 'Nothing was selected, so nothing was added.';
  }
  const bits = [`${created} fact${created === 1 ? '' : 's'} added`];
  if (rolesCreated > 0) bits.push(`${rolesCreated} role${rolesCreated === 1 ? '' : 's'}`);
  if (duplicates > 0) bits.push(`${duplicates} already present`);
  if (contactUpdated) bits.push('contact details filled in');
  if (unreadable > 0) bits.push(`${unreadable} incomplete and skipped`);
  return bits.join(', ');
}
