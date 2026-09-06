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

const Tags = z.array(z.string()).default([]);

const BulletIn = z.object({
  text: z.string().min(1),
  action: z.string().default(''),
  scale: z.string().optional(),
  outcome: z.string().optional(),
  tags: Tags,
});

const RoleIn = z.object({
  title: z.string().min(1),
  company: z.string().default(''),
  startDate: z.string().default(''),
  endDate: z.string().default('present'),
  bullets: z.array(BulletIn).default([]),
});

const RecordIn = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('skill'),
    name: z.string().min(1),
    category: z.enum(['language', 'framework', 'tool', 'platform', 'soft-skill']),
    tags: Tags,
  }),
  z.object({
    type: z.literal('project'),
    name: z.string().min(1),
    description: z.string().default(''),
    stack: z.array(z.string()).default([]),
    links: z.array(z.string()).default([]),
    impactMetrics: z.array(z.string()).default([]),
    tags: Tags,
  }),
  z.object({
    type: z.literal('education'),
    institution: z.string().min(1),
    credential: z.string().default(''),
    field: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    tags: Tags,
  }),
  z.object({
    type: z.literal('certification'),
    name: z.string().min(1),
    issuer: z.string().default(''),
    tags: Tags,
  }),
  z.object({
    type: z.literal('achievement'),
    title: z.string().min(1),
    description: z.string().default(''),
    tags: Tags,
  }),
]);

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
  roles: z.array(RoleIn).default([]),
  records: z.array(RecordIn).default([]),
});

export type CommitPayload = z.infer<typeof CommitPayloadSchema>;

export interface CommitSummary {
  created: number;
  duplicates: number;
  rolesCreated: number;
  contactUpdated: boolean;
  message: string;
}

/** Mirrors lib/sync/parse.ts so an imported fact and a synced one hash identically. */
function hashFor(rec: z.infer<typeof RecordIn>): string {
  switch (rec.type) {
    case 'skill':
      return hashContent(['skill', rec.name, rec.category]);
    case 'project':
      return hashContent(['project', rec.name, rec.description, rec.stack.join(',')]);
    case 'education':
      return hashContent(['education', rec.institution, rec.credential]);
    case 'certification':
      return hashContent(['cert', rec.name, rec.issuer]);
    case 'achievement':
      return hashContent(['achievement', rec.title]);
  }
}

export async function commitImport(
  userId: string,
  payload: CommitPayload,
): Promise<CommitSummary> {
  let created = 0;
  let duplicates = 0;
  let rolesCreated = 0;

  // --- Roles first: a bullet's roleId must be a real row id, or the assembler has
  // nothing to group it under and it renders as a loose line with no employer.
  for (const role of payload.roles) {
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
          source: 'ai-import',
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
      });
      if (wrote) created += 1;
      else duplicates += 1;
    }
  }

  for (const rec of payload.records) {
    const { type, tags, ...data } = rec;
    const wrote = await insertRecord(userId, {
      type,
      contentHash: hashFor(rec),
      tags,
      data: data as Record<string, unknown>,
    });
    if (wrote) created += 1;
    else duplicates += 1;
  }

  const contactUpdated = await writeContact(userId, payload.contact ?? null);

  return {
    created,
    duplicates,
    rolesCreated,
    contactUpdated,
    message: summarize(created, duplicates, rolesCreated, contactUpdated),
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
): Promise<boolean> {
  const inserted = await db
    .insert(profileRecords)
    .values({
      userId,
      type: input.type,
      source: 'ai-import',
      contentHash: input.contentHash,
      tags: input.tags ?? [],
      data: input.data,
    })
    .onConflictDoNothing()
    .returning({ id: profileRecords.id });

  if (inserted.length === 0) return false;

  // REQ-10.1 — one audit row per created record, naming the source.
  await audit(userId, inserted[0].id, 'create', 'ai-import', {
    type: input.type,
    contentHash: input.contentHash,
  });
  return true;
}

/**
 * Contact details fill gaps rather than overwrite. Whatever is already stored was either
 * typed by the user or pulled from their live portfolio; a resume PDF is usually the
 * older of the two, so it should not be able to replace a current phone number.
 */
async function writeContact(
  userId: string,
  contact: CommitPayload['contact'],
): Promise<boolean> {
  if (!contact) return false;

  const [existing] = await db
    .select()
    .from(contactInfo)
    .where(eq(contactInfo.userId, userId))
    .limit(1);

  const merged = {
    fullName: existing?.fullName || contact.fullName || '',
    email: existing?.email || contact.email || '',
    phone: existing?.phone || contact.phone || null,
    location: existing?.location || contact.location || null,
    portfolioUrl: existing?.portfolioUrl || contact.portfolioUrl || null,
    githubUrl: existing?.githubUrl || contact.githubUrl || null,
    linkedinUrl: existing?.linkedinUrl || contact.linkedinUrl || null,
  };

  await db
    .insert(contactInfo)
    .values({ userId, ...merged })
    .onConflictDoUpdate({ target: contactInfo.userId, set: merged });

  await audit(userId, null, 'update', 'ai-import', { contact: true });
  return true;
}

function summarize(
  created: number,
  duplicates: number,
  rolesCreated: number,
  contactUpdated: boolean,
): string {
  if (created === 0 && !contactUpdated && rolesCreated === 0) {
    return duplicates > 0
      ? `Everything selected was already in your profile — nothing added.`
      : 'Nothing was selected, so nothing was added.';
  }
  const bits = [`${created} fact${created === 1 ? '' : 's'} added`];
  if (rolesCreated > 0) bits.push(`${rolesCreated} role${rolesCreated === 1 ? '' : 's'}`);
  if (duplicates > 0) bits.push(`${duplicates} already present`);
  if (contactUpdated) bits.push('contact details filled in');
  return bits.join(', ');
}
