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
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { contactInfo, profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { audit } from '@/lib/server/profile';
import { hashContent } from '@/lib/sync/reconcile';
import { formFor, hashInput, missingRequired } from '@/lib/profile/forms';
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
  bullets: z.array(BulletIn).max(100).default([]),
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
  // Bounded so a payload cannot be used as unmetered storage. A real resume yields tens
  // of records, not thousands; anything past these caps is not an import.
  roles: z.array(RoleIn).max(200).default([]),
  records: z.array(RecordIn).max(2000).default([]),
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

export async function commitImport(
  userId: string,
  payload: CommitPayload,
  /** Provenance for everything written, so REQ-1.2 stays truthful per source. */
  source: RecordSource = 'ai-import',
): Promise<CommitSummary> {
  let created = 0;
  let duplicates = 0;
  let rolesCreated = 0;

  // --- Roles first: a bullet's roleId must be a real row id, or the assembler has
  // nothing to group it under and it renders as a loose line with no employer.
  for (const raw of payload.roles) {
    const role = {
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
    };
    const roleHash = hashContent(['role', role.company, role.title, role.startDate]);

    const [existing] = await db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(
        and(eq(rolesTable.userId, userId), eq(rolesTable.contentHash, roleHash)),
      )
      .limit(1);

    let roleId = existing?.id;
    if (!roleId) {
      const [inserted] = await db
        .insert(rolesTable)
        .values({
          userId,
          title: role.title,
          company: role.company,
          startDate: role.startDate,
          endDate: role.endDate || 'present',
          source,
          contentHash: roleHash,
        })
        .returning({ id: rolesTable.id });
      roleId = inserted.id;
      rolesCreated += 1;
    }

    for (const bullet of role.bullets) {
      const contentHash = hashContent(['bullet', role.company, bullet.text]);
      const wrote = await insertRecord(userId, {
        type: 'experience-bullet',
        contentHash,
        tags: bullet.tags,
        data: {
          roleId,
          text: bullet.text,
          action: bullet.action || bullet.text,
          scale: bullet.scale,
          outcome: bullet.outcome,
        },
      }, source);
      if (wrote) created += 1;
      else duplicates += 1;
    }
  }

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
    const wrote = await insertRecord(
      userId,
      {
        type: rec.type,
        contentHash: hashContent(hashInput(form, data)),
        tags: rec.tags,
        data,
      },
      source,
    );
    if (wrote) created += 1;
    else duplicates += 1;
  }

  const contactUpdated = await writeContact(userId, payload.contact ?? null, source);

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
 * Returns false when the record was already in the profile. The unique index on
 * (userId, contentHash) is what makes re-importing the same file safe: a second import
 * adds nothing rather than duplicating a career.
 */
async function insertRecord(
  userId: string,
  input: {
    type: string;
    contentHash: string;
    tags: string[];
    data: Record<string, unknown>;
  },
  source: RecordSource,
): Promise<boolean> {
  const inserted = await db
    .insert(profileRecords)
    .values({
      userId,
      type: input.type,
      source,
      contentHash: input.contentHash,
      tags: input.tags ?? [],
      data: input.data,
    })
    .onConflictDoNothing()
    .returning({ id: profileRecords.id });

  if (inserted.length === 0) return false;

  // REQ-10.1 — one audit row per created record, naming the source.
  await audit(userId, inserted[0].id, 'create', source, {
    type: input.type,
    contentHash: input.contentHash,
  });
  return true;
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
