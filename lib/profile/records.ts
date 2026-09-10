import 'server-only';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { hashContent } from '@/lib/sync/reconcile';
import { deriveTags } from '@/lib/sync/tags';
import { audit } from '@/lib/server/profile';
import { composeBulletText } from './bullet';
import {
  coerceFormValues,
  formFor,
  hashInput,
  RECORD_FORMS,
  missingRequired,
  tagSource,
  type RecordForm,
} from './forms';

/**
 * Writing profile records by hand.
 *
 * Everything written here is `source: 'manual'`, which is load-bearing rather than
 * cosmetic: `lib/sync/reconcile.ts` never reads manual rows into any of its maps, so a
 * later sync cannot overwrite or flag something the user typed. That is the whole reason
 * this path is safe to offer alongside an automated one.
 *
 * Hashes are always recomputed from the submitted content. A client-supplied hash would
 * let a caller collide with or overwrite an unrelated row, since `(userId, contentHash)`
 * is the table's unique key.
 */

export class DuplicateRecordError extends Error {
  constructor() {
    super('You already have this saved.');
    this.name = 'DuplicateRecordError';
  }
}

const nonEmpty = z.string().trim().min(1);

export const BulletInput = z.object({
  roleId: nonEmpty,
  action: nonEmpty.max(300),
  scale: z.string().trim().max(200).optional(),
  outcome: z.string().trim().max(300).optional(),
});

export const SkillInput = z.object({
  name: nonEmpty.max(80),
  category: z.enum(['language', 'framework', 'tool', 'platform', 'soft-skill']),
  /**
   * Where the user says they used this — set only by the enrichment queue, which will
   * not add a skill without it (lib/server/enrichment.ts).
   *
   * Stored on the record and deliberately kept OUT of the hash and out of `tagSource`.
   * Out of the hash so this skill still collides with the identical one a sync finds, as
   * `identityFields` promises. Out of the tags because tags are the profile's vocabulary
   * — `profileVocabulary` reads them, and `holdsKeyword` decides from them what a resume
   * may claim. Feeding a free-text sentence into that would let "I used it alongside
   * Kubernetes and Terraform" quietly evidence two skills nobody attested to, which is
   * exactly the widening NFR-8 exists to prevent.
   */
  evidence: z.string().trim().max(400).optional(),
});

export const ProjectInput = z.object({
  name: nonEmpty.max(120),
  description: z.string().trim().max(600).default(''),
  stack: z.array(z.string().trim()).default([]),
  links: z.array(z.string().trim()).default([]),
  impactMetrics: z.array(z.string().trim()).default([]),
});

export const SimpleTextInput = z.object({ text: nonEmpty.max(1200) });

/**
 * Duplicate content is "you already have this", not a database error to leak upward.
 *
 * The chain is walked because Drizzle wraps driver errors: the thrown error is a plain
 * `Error` whose message is the SQL, and the PostgresError carrying code 23505 is its
 * `cause`. Checking only the top-level object matched nothing, so every duplicate
 * reached the user as "Failed query: insert into ..." instead.
 */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function insertRecord(args: {
  userId: string;
  type: string;
  data: Record<string, unknown>;
  /**
   * The complete hash input, prefix included — not just the identifying values. The
   * prefix is not always the type name (sync writes 'cert' for a certification), and
   * a prefix this function invented would hash the same fact two ways.
   */
  hashParts: string[];
  tagSource: string;
}): Promise<string> {
  const contentHash = hashContent(args.hashParts);

  try {
    const [row] = await db
      .insert(profileRecords)
      .values({
        userId: args.userId,
        type: args.type,
        source: 'manual',
        contentHash,
        tags: deriveTags(args.tagSource),
        data: args.data,
      })
      .returning({ id: profileRecords.id });

    await audit(args.userId, row.id, 'create', 'manual', { type: args.type });
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateRecordError();
    throw err;
  }
}

/**
 * A bullet must belong to one of the caller's own roles.
 *
 * Not merely an ownership check: a `roleId` that doesn't resolve puts the bullet in the
 * orphan bucket at assembly time, where it silently never reaches a resume. That failed
 * quietly once already, so it fails loudly here instead.
 */
async function assertOwnsRole(userId: string, roleId: string): Promise<void> {
  const [role] = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.userId, userId)))
    .limit(1);
  if (!role) throw new Error('That role does not exist on your profile.');
}

export async function createBullet(
  userId: string,
  input: z.infer<typeof BulletInput>,
): Promise<string> {
  const parsed = BulletInput.parse(input);
  await assertOwnsRole(userId, parsed.roleId);

  const text = composeBulletText(parsed);
  return insertRecord({
    userId,
    type: 'experience-bullet',
    data: {
      roleId: parsed.roleId,
      text,
      action: parsed.action,
      scale: parsed.scale || undefined,
      outcome: parsed.outcome || undefined,
    },
    hashParts: ['experience-bullet', parsed.roleId, text],
    tagSource: text,
  });
}

export async function updateBullet(
  userId: string,
  recordId: string,
  input: z.infer<typeof BulletInput>,
): Promise<void> {
  const parsed = BulletInput.parse(input);
  await assertOwnsRole(userId, parsed.roleId);

  const text = composeBulletText(parsed);
  const contentHash = hashContent(['experience-bullet', parsed.roleId, text]);

  const updated = await db
    .update(profileRecords)
    .set({
      contentHash,
      tags: deriveTags(text),
      data: {
        roleId: parsed.roleId,
        text,
        action: parsed.action,
        scale: parsed.scale || undefined,
        outcome: parsed.outcome || undefined,
      },
      // Editing a synced bullet makes it the user's own, so a later sync stops
      // competing with it — the same promotion the flagged-record review does.
      source: 'manual',
      updatedAt: new Date(),
    })
    .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)))
    .returning({ id: profileRecords.id });

  if (updated.length === 0) throw new Error('That entry no longer exists.');
  await audit(userId, recordId, 'update', 'manual', { type: 'experience-bullet' });
}

export async function deleteRecord(userId: string, recordId: string): Promise<void> {
  const deleted = await db
    .delete(profileRecords)
    .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)))
    .returning({ id: profileRecords.id, type: profileRecords.type });

  if (deleted.length === 0) throw new Error('That entry no longer exists.');
  await audit(userId, recordId, 'delete', 'manual', { type: deleted[0].type });
}

export async function createSkill(
  userId: string,
  input: z.infer<typeof SkillInput>,
): Promise<string> {
  const parsed = SkillInput.parse(input);
  return insertRecord({
    userId,
    type: 'skill',
    data: {
      name: parsed.name,
      category: parsed.category,
      ...(parsed.evidence ? { evidence: parsed.evidence } : {}),
    },
    hashParts: ['skill', parsed.name, parsed.category],
    tagSource: parsed.name,
  });
}

export async function createProject(
  userId: string,
  input: z.infer<typeof ProjectInput>,
): Promise<string> {
  const parsed = ProjectInput.parse(input);
  return insertRecord({
    userId,
    type: 'project',
    data: parsed,
    hashParts: ['project', parsed.name, parsed.description, parsed.stack.join(',')],
    tagSource: `${parsed.name} ${parsed.description} ${parsed.stack.join(' ')}`,
  });
}

/** Adds outcomes to an existing project — AUDIT.md #5, where none of 32 stated one. */
export async function setProjectMetrics(
  userId: string,
  recordId: string,
  metrics: string[],
): Promise<void> {
  const clean = metrics.map((m) => m.trim()).filter(Boolean).slice(0, 6);

  const [existing] = await db
    .select({ data: profileRecords.data })
    .from(profileRecords)
    .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)))
    .limit(1);
  if (!existing) throw new Error('That project no longer exists.');

  const previous = existing.data as Record<string, unknown>;
  const data = { ...previous, impactMetrics: clean };

  await db
    .update(profileRecords)
    .set({
      data,
      // Recording an outcome does not change which project this is, so the hash is
      // rebuilt from the identifying fields — including the stack, which the sync's
      // recipe includes and this once left out.
      contentHash: hashContent(hashInput(RECORD_FORMS.project, previous)),
      source: 'manual',
      updatedAt: new Date(),
    })
    .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)));

  await audit(userId, recordId, 'update', 'manual', { addedMetrics: clean.length });
}

export async function createSummary(userId: string, text: string): Promise<string> {
  const parsed = SimpleTextInput.parse({ text });

  // Only one summary is ever used, so replacing beats accumulating drafts.
  const existing = await db
    .select({ id: profileRecords.id })
    .from(profileRecords)
    .where(and(eq(profileRecords.userId, userId), eq(profileRecords.type, 'summary')));
  for (const row of existing) await deleteRecord(userId, row.id);

  return insertRecord({
    userId,
    type: 'summary',
    data: { text: parsed.text },
    hashParts: ['summary', parsed.text],
    tagSource: parsed.text,
  });
}

/*
 * Generic writes, driven by lib/profile/forms.ts.
 *
 * The per-type functions above stay because their inputs are not interchangeable — a
 * bullet needs a role, a summary replaces rather than accumulates. Everything else is
 * the same three steps over a different field list, and writing twelve near-identical
 * functions is how a field ends up validated in one place and dropped in another.
 */

/** A field longer than the form allows is rejected, not silently cut short. */
function enforceLimits(form: RecordForm, data: Record<string, unknown>): void {
  for (const field of form.fields) {
    const value = data[field.name];
    if (typeof value === 'string' && field.maxLength && value.length > field.maxLength) {
      throw new Error(`${field.label} is longer than ${field.maxLength} characters.`);
    }
    if (field.kind === 'select' && typeof value === 'string' && field.options) {
      if (!field.options.includes(value)) throw new Error(`${field.label} is not a valid choice.`);
    }
  }
}

function prepare(type: string, raw: Record<string, string>) {
  const form = formFor(type);
  if (!form) throw new Error(`${type} cannot be edited here.`);

  const data = coerceFormValues(form, raw);
  const missing = missingRequired(form, data);
  if (missing.length > 0) throw new Error(`${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} required.`);
  enforceLimits(form, data);

  return { form, data };
}

export async function createTypedRecord(
  userId: string,
  type: string,
  raw: Record<string, string>,
): Promise<string> {
  // The summary is single-valued, so it keeps its replace-rather-than-append path.
  if (type === 'summary') return createSummary(userId, raw.text ?? '');

  const { form, data } = prepare(type, raw);
  return insertRecord({
    userId,
    type: form.type,
    data,
    hashParts: hashInput(form, data),
    tagSource: tagSource(form, data),
  });
}

export async function updateTypedRecord(
  userId: string,
  recordId: string,
  type: string,
  raw: Record<string, string>,
): Promise<void> {
  const { form, data } = prepare(type, raw);

  // The type comes from the client, so it is checked against the row rather than
  // trusted: a mismatch would rewrite an award as a language and lose both.
  const [existing] = await db
    .select({ type: profileRecords.type })
    .from(profileRecords)
    .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)))
    .limit(1);
  if (!existing) throw new Error('That entry no longer exists.');
  if (existing.type !== form.type) throw new Error('That entry is not a ' + form.singular + '.');

  try {
    const updated = await db
      .update(profileRecords)
      .set({
        data,
        contentHash: hashContent(hashInput(form, data)),
        tags: deriveTags(tagSource(form, data)),
        // Editing a synced record promotes it to the user's own, so the next sync stops
        // competing with the edit — the same rule updateBullet follows.
        source: 'manual',
        flaggedForRemoval: false,
        updatedAt: new Date(),
      })
      .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)))
      .returning({ id: profileRecords.id });

    if (updated.length === 0) throw new Error('That entry no longer exists.');
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateRecordError();
    throw err;
  }

  await audit(userId, recordId, 'update', 'manual', { type: form.type });
}
