import 'server-only';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { profileRecords, roles as rolesTable } from '@/lib/db/schema';
import { bulletHash, hashContent } from '@/lib/sync/reconcile';
import { deriveTags } from '@/lib/sync/tags';
import { audit } from '@/lib/server/profile';
import {
  dismissalKeysFor,
  dismissBulletRows,
  dismissRecordRow,
  dismissRoleRow,
  forgetDismissalFor,
} from '@/lib/server/dismissals';
import { composeBulletText } from './bullet';
import { tidyDate, tidyRecordData, tidyText } from '../steward/tidy';
import { roleDateProblem, roleIdentity, sameJob } from '@/lib/sync/roles';
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
  constructor(message = 'You already have this saved.') {
    super(message);
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
  category: z.enum(['language', 'framework', 'tool', 'platform', 'method', 'soft-skill']),
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
  hashParts?: string[];
  /** Set instead of `hashParts` where the recipe is not a list of parts (bullets). */
  contentHash?: string;
  tagSource: string;
}): Promise<string> {
  const contentHash = args.contentHash ?? hashContent(args.hashParts ?? []);

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

    // Typed back in after being removed: the block was the earlier answer, and this is
    // the later one. Left in place, the Removed list would keep offering to restore
    // something already on the profile.
    await forgetDismissalFor(args.userId, dismissalKeysFor(args.type, args.data, contentHash));
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
async function assertOwnsRole(userId: string, roleId: string): Promise<{ company: string }> {
  const [role] = await db
    .select({ company: rolesTable.company })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.userId, userId)))
    .limit(1);
  if (!role) throw new Error('That role does not exist on your profile.');
  return role;
}

/** A bullet's three parts with layer-1 tidying — see lib/steward/tidy.ts. */
function tidyBullet<T extends { action: string; scale?: string; outcome?: string }>(b: T): T {
  return {
    ...b,
    action: tidyText(b.action),
    scale: b.scale === undefined ? undefined : tidyText(b.scale),
    outcome: b.outcome === undefined ? undefined : tidyText(b.outcome),
  };
}

export async function createBullet(
  userId: string,
  input: z.infer<typeof BulletInput>,
): Promise<string> {
  const parsed = tidyBullet(BulletInput.parse(input));
  const { company } = await assertOwnsRole(userId, parsed.roleId);

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
    contentHash: bulletHash(company, text),
    tagSource: text,
  });
}

export async function updateBullet(
  userId: string,
  recordId: string,
  input: z.infer<typeof BulletInput>,
): Promise<void> {
  const parsed = tidyBullet(BulletInput.parse(input));
  const { company } = await assertOwnsRole(userId, parsed.roleId);

  const text = composeBulletText(parsed);
  const contentHash = bulletHash(company, text);

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

/* ------------------------------------------------------------------ jobs ---- */

export const RoleInput = z.object({
  title: nonEmpty.max(200),
  company: nonEmpty.max(200),
  location: z.string().trim().max(120).optional(),
  startDate: z.string().trim().max(32),
  endDate: z.string().trim().max(32),
});

/**
 * The job's fields tidied and checked, or an error saying what to fix.
 *
 * Jobs had no writer but the importers and the sync, so a misspelt company, an empty start
 * date or a duplicate an import created could never be corrected — in the section every
 * resume leads with.
 */
function prepareRole(input: z.infer<typeof RoleInput>) {
  const parsed = RoleInput.parse(input);
  const role = {
    title: tidyText(parsed.title),
    company: tidyText(parsed.company),
    location: parsed.location ? tidyText(parsed.location) : null,
    startDate: tidyDate(parsed.startDate),
    endDate: parsed.endDate ? tidyDate(parsed.endDate) : 'present',
  };
  const problem = roleDateProblem(role.startDate, role.endDate);
  if (problem) throw new Error(problem);
  return role;
}

/** Refuses a second copy of a job the profile already holds, however it is spelled. */
async function assertNewJob(
  userId: string,
  role: { company: string; title: string; startDate: string; endDate: string },
  exceptId?: string,
) {
  const others = await db
    .select({ id: rolesTable.id, company: rolesTable.company, title: rolesTable.title, startDate: rolesTable.startDate, endDate: rolesTable.endDate })
    .from(rolesTable)
    .where(and(eq(rolesTable.userId, userId), ne(rolesTable.reviewState, 'rejected')));
  // Same identity AND overlapping/adjacent dates: an internship then a full-time role at one
  // company is two jobs, not a duplicate.
  if (others.some((r) => r.id !== exceptId && sameJob(r, role))) {
    throw new DuplicateRecordError('That job is already on your profile.');
  }
}

export async function createRole(userId: string, input: z.infer<typeof RoleInput>): Promise<string> {
  const role = prepareRole(input);
  await assertNewJob(userId, role);
  const contentHash = hashContent(['role', role.company, role.title, role.startDate]);
  await forgetDismissalFor(userId, {
    contentHash,
    identityKey: `role:${roleIdentity(role.company, role.title)}`,
  });
  const [row] = await db
    .insert(rolesTable)
    .values({ userId, ...role, source: 'manual', contentHash })
    .returning({ id: rolesTable.id });
  await audit(userId, null, 'create', 'manual', { type: 'role', roleId: row.id });
  return row.id;
}

export async function updateRole(userId: string, roleId: string, input: z.infer<typeof RoleInput>): Promise<void> {
  const role = prepareRole(input);
  await assertNewJob(userId, role, roleId);
  const updated = await db
    .update(rolesTable)
    .set({
      ...role,
      // Edited by hand is the user's own, so a later sync matches it rather than
      // proposing its own spelling again — the same promotion an edited bullet gets.
      source: 'manual',
      reviewState: 'approved',
      contentHash: hashContent(['role', role.company, role.title, role.startDate]),
    })
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.userId, userId)))
    .returning({ id: rolesTable.id });
  if (updated.length === 0) throw new Error('That job no longer exists.');
  await audit(userId, null, 'update', 'manual', { type: 'role', roleId });
}

/**
 * Removes a job. Its accomplishments are moved to `moveTo` — the way two copies of one job
 * become one — or removed with it.
 *
 * Bullets point at their job only through `data.roleId`, with no foreign key, so a plain
 * delete would leave them orphaned: invisible on the profile and dropped from every draft.
 */
export async function deleteRole(userId: string, roleId: string, moveTo?: string | null): Promise<void> {
  if (moveTo === roleId) throw new Error('Choose a different job to move them to.');
  const target = moveTo ? await assertOwnsRole(userId, moveTo) : null;
  let removedRole: typeof rolesTable.$inferSelect | null = null;
  let removedBullets: Array<typeof profileRecords.$inferSelect> = [];

  await db.transaction(async (tx) => {
    const bulletsOf = and(
      eq(profileRecords.userId, userId),
      eq(profileRecords.type, 'experience-bullet'),
      sql`${profileRecords.data}->>'roleId' = ${roleId}`,
    );
    if (moveTo && target) {
      // A bullet's identity includes its job's company, so a moved bullet has a new one.
      // One the target job already holds is a duplicate and goes, rather than failing the
      // move on the unique index. Moved bullets become the user's own: the sync would
      // otherwise propose them again under the job they came from.
      const bullets = await tx.select().from(profileRecords).where(bulletsOf);
      for (const b of bullets) {
        const data: Record<string, unknown> = { ...(b.data as Record<string, unknown>), roleId: moveTo };
        const contentHash = bulletHash(target.company, String(data.text ?? ''));
        const [clash] = await tx
          .select({ id: profileRecords.id })
          .from(profileRecords)
          .where(and(eq(profileRecords.userId, userId), eq(profileRecords.contentHash, contentHash), ne(profileRecords.id, b.id)))
          .limit(1);
        if (clash) await tx.delete(profileRecords).where(eq(profileRecords.id, b.id));
        else {
          await tx
            .update(profileRecords)
            .set({ data, contentHash, source: 'manual', updatedAt: new Date() })
            .where(eq(profileRecords.id, b.id));
        }
      }
    } else {
      // Kept before the delete so each line can be remembered: a job removed with its
      // accomplishments must not come back as a job with its accomplishments.
      removedBullets = await tx.select().from(profileRecords).where(bulletsOf);
      await tx.delete(profileRecords).where(bulletsOf);
    }
    const deleted = await tx
      .delete(rolesTable)
      .where(and(eq(rolesTable.id, roleId), eq(rolesTable.userId, userId)))
      .returning();
    if (deleted.length === 0) throw new Error('That job no longer exists.');
    removedRole = deleted[0];
  });

  // After the transaction: a mark is a record of a decision, not part of the delete, and
  // failing to write one must never roll back the removal the user asked for.
  if (removedRole) await dismissRoleRow(userId, removedRole);
  await dismissBulletRows(userId, removedBullets);
  await audit(userId, null, 'delete', 'manual', { type: 'role', roleId, movedTo: moveTo ?? null });
}

export async function deleteRecord(
  userId: string,
  recordId: string,
  /**
   * Whether to remember the removal, so no sync or import proposes it again
   * (lib/server/dismissals.ts). False for the one caller that deletes a row as part of
   * REPLACING it — `createSummary` — where remembering would block the replacement's own
   * successor. Every other delete is a person saying "I do not want this".
   */
  options: { remember?: boolean } = {},
): Promise<void> {
  const deleted = await db
    .delete(profileRecords)
    .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)))
    .returning();

  if (deleted.length === 0) throw new Error('That entry no longer exists.');
  if (options.remember !== false) await dismissRecordRow(userId, deleted[0]);
  await audit(userId, recordId, 'delete', 'manual', { type: deleted[0].type });
}

export async function createSkill(
  userId: string,
  input: z.infer<typeof SkillInput>,
): Promise<string> {
  const parsed = SkillInput.parse(input);
  parsed.name = tidyRecordData('skill', { name: parsed.name }).name as string;
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
  const parsed = tidyRecordData('project', ProjectInput.parse(input)) as z.infer<typeof ProjectInput>;
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
  const clean = metrics.map(tidyText).filter(Boolean).slice(0, 6);

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
  const parsed = SimpleTextInput.parse({ text: tidyText(text) });

  // Only one summary is ever used, so replacing beats accumulating drafts.
  const existing = await db
    .select({ id: profileRecords.id })
    .from(profileRecords)
    .where(and(eq(profileRecords.userId, userId), eq(profileRecords.type, 'summary')));
  // Replacing, not removing: `remember: false`, or the summary just written would be
  // blocked the next time the portfolio proposes one.
  for (const row of existing) await deleteRecord(userId, row.id, { remember: false });

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

  // Layer-1 tidying before validation and hashing, so the hash is of what is stored.
  const data = tidyRecordData(form.type, coerceFormValues(form, raw));
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

/**
 * Sets some fields of one record and leaves the rest as stored — the steward's writer.
 *
 * Not `updateTypedRecord`: that rebuilds a record from its form, which drops any field
 * the form does not show (a skill's `evidence`, which the enrichment queue stored and
 * nothing else can restore). A steward fix changes one field and must keep everything
 * else. Same validation, same tidying, same hash recipe, same promotion to `manual`.
 *
 * A value of '' or [] removes the field. Bullets are handled here too, because their hash
 * recipe is their own: role and text.
 */
export async function patchRecord(
  userId: string,
  recordId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const [existing] = await db
    .select({ type: profileRecords.type, data: profileRecords.data })
    .from(profileRecords)
    .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)))
    .limit(1);
  if (!existing) throw new Error('That entry no longer exists.');

  const merged: Record<string, unknown> = { ...(existing.data as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === '' || (Array.isArray(value) && value.length === 0)) delete merged[key];
    else merged[key] = value;
  }

  let data: Record<string, unknown>;
  let contentHash: string;
  let tags: string[];
  if (existing.type === 'experience-bullet') {
    data = tidyRecordData('experience-bullet', merged);
    const text = String(data.text ?? '');
    if (!text) throw new Error('A bullet cannot be empty.');
    const { company } = await assertOwnsRole(userId, String(data.roleId ?? ''));
    contentHash = bulletHash(company, text);
    tags = deriveTags(text);
  } else {
    const form = formFor(existing.type);
    if (!form) throw new Error(`${existing.type} cannot be edited here.`);
    data = tidyRecordData(form.type, merged);
    const missing = missingRequired(form, data);
    if (missing.length > 0) throw new Error(`${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} required.`);
    enforceLimits(form, data);
    contentHash = hashContent(hashInput(form, data));
    tags = deriveTags(tagSource(form, data));
  }

  try {
    await db
      .update(profileRecords)
      .set({ data, contentHash, tags, source: 'manual', flaggedForRemoval: false, updatedAt: new Date() })
      .where(and(eq(profileRecords.id, recordId), eq(profileRecords.userId, userId)));
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateRecordError();
    throw err;
  }
  await audit(userId, recordId, 'update', 'manual', { type: existing.type, fields: Object.keys(patch) });
}
