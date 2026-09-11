/**
 * The profile steward on the server — STEWARD.md §3.
 *
 * Four jobs, one per way the steward meets the user:
 *
 *   reviewSection    the profile page's "Review my profile", one section and one batch per
 *                    request so each finishes inside the host's 30-second limit.
 *   applySuggestion  what happens when the user presses Apply. Re-reads every record the
 *                    suggestion concerns and refuses if any changed since it was made.
 *   checkCandidate   the check between a form's Save and the database.
 *   extractForProfile / commitFromAssistant   "Add with AI".
 *
 * The model is never trusted with a write. Everything it proposes has passed
 * lib/steward/verify.ts, and everything written goes through the same record writers the
 * forms use, so validation, hashing, provenance and the audit trail are theirs.
 */

import 'server-only';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { profileRecords, roles as rolesTable, stewardDismissals } from '@/lib/db/schema';
import { DRAFT_BUDGET, DraftBudget } from '@/lib/ai/budget';
import { assertDailyBudget, recordDailyUsage } from '@/lib/ai/daily-budget';
import { audit } from '@/lib/server/profile';
import { hashContent } from '@/lib/sync/reconcile';
import { coerceFormValues, formFor, hashInput } from '@/lib/profile/forms';
import {
  DuplicateRecordError,
  createBullet,
  createTypedRecord,
  deleteRecord,
  patchRecord,
} from '@/lib/profile/records';
import { extractClaims, groundClaims, toCommitPayload } from '@/lib/profile/claim';
import { composeBulletText } from '@/lib/profile/bullet';
import { CommitPayloadSchema, commitImport } from '@/lib/import/commit';
import { proposeChanges } from '@/lib/steward/agent';
import { WEAK_OPENERS, labelOf, ruleSuggestions, skillKeys, words } from '@/lib/steward/rules';
import { tidyRecordData } from '@/lib/steward/tidy';
import { SKILL_CATEGORY_LABELS, classifySkill, skillCategoryKey, suggestedSkillCategory } from '@/lib/skills/categories';
import { classifyUnknownSkills } from '@/lib/skills/classify-ai';
import { verifyProposals } from '@/lib/steward/verify';
import {
  sectionOf,
  suggestionId,
  type StewardProfile,
  type StewardRecord,
  type StewardSection,
  type Suggestion,
} from '@/lib/steward/types';

/* ---------------------------------------------------------------- loading -- */

export async function loadStewardProfile(userId: string): Promise<StewardProfile> {
  const [rows, roleRows] = await Promise.all([
    db
      .select()
      .from(profileRecords)
      .where(and(eq(profileRecords.userId, userId), ne(profileRecords.reviewState, 'rejected'))),
    db
      .select()
      .from(rolesTable)
      .where(and(eq(rolesTable.userId, userId), ne(rolesTable.reviewState, 'rejected'))),
  ]);
  return {
    records: rows.map((r) => ({
      id: r.id,
      type: r.type,
      source: r.source,
      reviewState: r.reviewState,
      contentHash: r.contentHash,
      data: r.data as Record<string, unknown>,
    })),
    roles: roleRows.map((r) => ({
      id: r.id,
      title: r.title,
      company: r.company,
      startDate: r.startDate,
      endDate: r.endDate,
      reviewState: r.reviewState,
    })),
  };
}

/* ----------------------------------------------------------------- review -- */

/**
 * Records per model call, per section.
 *
 * Measured on the owner's profile: 25 short skill records answered in 5–16 s and 12
 * projects in 7–15 s — but in production the slow end of that range spent the whole 22 s
 * budget on the first provider, so the batch failed instead of falling through to a faster
 * one. These sizes leave room for a second provider inside the same request.
 */
export const BATCH_SIZE: Record<StewardSection, number> = {
  skills: 20,
  experience: 12,
  projects: 10,
  credentials: 15,
  other: 15,
};

const MODEL_TYPES_OTHER = new Set(['summary', 'achievement', 'award', 'volunteering', 'publication', 'writing']);

/**
 * What the model is shown for a section: only records it has something to judge in.
 *
 * Skills are not among them. The rules already merge the duplicates and fix the spelling,
 * and asked about the rest the model mostly proposed moving a skill between categories
 * that the resume barely distinguishes — "Generative AI is a tool, not a framework" —
 * which is noise for the reader and, at a hundred skills, five model calls of the dozen a
 * review makes. It is the cheapest call to not make.
 */
function modelCandidates(profile: StewardProfile, section: StewardSection): StewardRecord[] {
  if (section === 'skills') return [];
  return profile.records.filter((r) => {
    if (sectionOf(r.type) !== section) return false;
    if (r.type === 'experience-bullet') return !r.data.scale && !r.data.outcome;
    if (section === 'other') return MODEL_TYPES_OTHER.has(r.type);
    return true;
  });
}

export interface ReviewPage {
  section: StewardSection;
  batch: number;
  batches: number;
  suggestions: Suggestion[];
  /** 'failed' when the model could not be reached; the rule suggestions still stand. */
  model: 'ok' | 'none' | 'failed';
}

async function dismissedFor(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: stewardDismissals.suggestionId })
    .from(stewardDismissals)
    .where(eq(stewardDismissals.userId, userId));
  return new Set(rows.map((r) => r.id));
}

/**
 * Time for one review request's model calls, inside the host's 30-second ceiling.
 *
 * 22 s measured as too much: with the profile loaded first and the usage written after,
 * requests ran to 29.4 s and two were killed at exactly 30 (a 504, and React's
 * "Connection closed" in the page). 17 s leaves a real margin and still fits two 8-second
 * provider attempts.
 */
const REVIEW_TIME_BUDGET_MS = 17_000;

export async function reviewSection(
  userId: string,
  section: StewardSection,
  batch: number,
): Promise<ReviewPage> {
  const [profile, dismissed] = await Promise.all([loadStewardProfile(userId), dismissedFor(userId)]);
  const rules = ruleSuggestions(profile, section);
  const candidates = modelCandidates(profile, section);
  const size = BATCH_SIZE[section];
  const batches = Math.max(1, Math.ceil(candidates.length / size));

  // The rules cover the whole section at once, so they ride on the first batch only.
  const suggestions: Suggestion[] = batch === 0 ? [...rules] : [];
  let model: ReviewPage['model'] = 'none';

  // Skills the deterministic layers cannot place: asked once, cached for everyone
  // (lib/skills/classify-ai.ts), and only on the section's first request.
  if (section === 'skills' && batch === 0) {
    const unplaced = profile.records.filter((r) => r.type === 'skill' && !classifySkill(String(r.data.name ?? '')));
    if (unplaced.length > 0) {
      const budget = new DraftBudget(DRAFT_BUDGET, REVIEW_TIME_BUDGET_MS, 1_000);
      try {
        await assertDailyBudget(userId);
        const found = await classifyUnknownSkills(unplaced.map((r) => String(r.data.name ?? '')), budget);
        for (const record of unplaced) {
          const answer = found.get(skillCategoryKey(String(record.data.name ?? '')));
          if (!answer || answer === record.data.category) continue;
          const draft = {
            kind: 'fix' as const,
            section: 'skills' as const,
            recordId: record.id,
            recordType: 'skill',
            label: labelOf(record),
            title: `File under ${SKILL_CATEGORY_LABELS[answer]}`,
            reason: `Nothing in the built-in list knows "${String(record.data.name)}", so it was classified for you.`,
            origin: 'ai' as const,
            quick: false,
            changes: { category: { from: record.data.category ?? '', to: answer } },
            basis: { [record.id]: record.contentHash },
          };
          suggestions.push({ ...draft, id: suggestionId(draft) });
        }
        model = 'ok';
      } catch (err) {
        console.warn('[steward] skill classification skipped:', err instanceof Error ? err.message.slice(0, 200) : err);
      } finally {
        await recordDailyUsage(userId, budget.snapshot());
      }
    }
  }

  const slice = candidates.slice(batch * size, (batch + 1) * size);
  if (slice.length > 0) {
    await assertDailyBudget(userId);
    const budget = new DraftBudget(DRAFT_BUDGET, REVIEW_TIME_BUDGET_MS, 1_000);
    try {
      const { proposals } = await proposeChanges({ section, records: slice, roles: profile.roles, budget });
      const verified = verifyProposals(proposals, slice, profile.roles, rules);
      if (verified.refused.length > 0) {
        console.log(`[steward] ${section} batch ${batch}: refused ${verified.refused.length}:`, verified.refused.join(' | ').slice(0, 800));
      }
      suggestions.push(...verified.suggestions);
      model = 'ok';
    } catch (err) {
      console.error(`[steward] ${section} batch ${batch} model call failed:`, err instanceof Error ? err.message.slice(0, 300) : err);
      model = 'failed';
    } finally {
      await recordDailyUsage(userId, budget.snapshot());
    }
  }

  return {
    section,
    batch,
    batches,
    suggestions: suggestions.filter((s) => !dismissed.has(s.id)),
    model,
  };
}

/* ------------------------------------------------------------------ apply -- */

export class StaleSuggestionError extends Error {
  constructor() {
    super('This part of your profile changed since the review. Run the review again.');
    this.name = 'StaleSuggestionError';
  }
}

const Changes = z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() }));

/** The suggestion as it comes back from the browser — checked, never trusted. */
export const SuggestionSchema = z.object({
  id: z.string().max(40),
  kind: z.enum(['fix', 'merge', 'move', 'remove', 'ask']),
  section: z.enum(['skills', 'experience', 'projects', 'credentials', 'other']),
  recordId: z.string().max(80),
  recordType: z.string().max(40),
  label: z.string().max(300),
  title: z.string().max(300),
  reason: z.string().max(400),
  origin: z.enum(['rule', 'ai']),
  quick: z.boolean(),
  changes: Changes.optional(),
  removeIds: z.array(z.string().max(80)).max(20).optional(),
  moveTo: z.object({ type: z.string().max(40), data: z.record(z.string(), z.unknown()) }).optional(),
  ask: z.object({ field: z.string().max(40), prompt: z.string().max(300), placeholder: z.string().max(200).optional() }).optional(),
  basis: z.record(z.string(), z.string()),
});

const roleBasis = (r: { title: string; company: string; startDate: string; endDate: string }) =>
  `${r.title}|${r.company}|${r.startDate}|${r.endDate}`;

/** Every record the suggestion was made against still exists, unchanged, and is the user's. */
async function assertFresh(userId: string, s: Suggestion): Promise<void> {
  const ids = Object.keys(s.basis);
  if (s.recordType === 'role') {
    const [role] = await db
      .select()
      .from(rolesTable)
      .where(and(eq(rolesTable.id, s.recordId), eq(rolesTable.userId, userId)))
      .limit(1);
    if (!role || roleBasis(role) !== s.basis[s.recordId]) throw new StaleSuggestionError();
    return;
  }
  const rows = await db
    .select({ id: profileRecords.id, hash: profileRecords.contentHash })
    .from(profileRecords)
    .where(and(eq(profileRecords.userId, userId), inArray(profileRecords.id, ids)));
  const current = new Map(rows.map((r) => [r.id, r.hash]));
  for (const id of ids) {
    if (current.get(id) !== s.basis[id]) throw new StaleSuggestionError();
  }
}

/** A stored value as the string a form field holds. */
function asFormValue(v: unknown): string {
  return Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
}

export async function applySuggestion(userId: string, raw: unknown, answer?: string): Promise<string> {
  const s = SuggestionSchema.parse(raw) as Suggestion;
  await assertFresh(userId, s);
  const given = (answer ?? '').trim();

  switch (s.kind) {
    case 'fix': {
      const patch = Object.fromEntries(Object.entries(s.changes ?? {}).map(([k, v]) => [k, v.to]));
      if (s.recordType === 'experience-bullet' && typeof patch.text === 'string') {
        // A reworded bullet's action is its new text, unless the user split it into parts.
        const [row] = await db.select({ data: profileRecords.data }).from(profileRecords).where(eq(profileRecords.id, s.recordId)).limit(1);
        const d = (row?.data ?? {}) as Record<string, unknown>;
        if (!d.scale && !d.outcome && patch.action === undefined) patch.action = patch.text;
      }
      try {
        await patchRecord(userId, s.recordId, patch);
      } catch (err) {
        // Re-filing "React.js" as a framework, next to a "React" already filed there, makes
        // the two one record. That is a merge the user already agreed to by applying it.
        const onlyCategory = s.recordType === 'skill' && Object.keys(patch).every((k) => k === 'category' || k === 'name');
        if (!(err instanceof DuplicateRecordError) || !onlyCategory) throw err;
        await deleteRecord(userId, s.recordId);
        await audit(userId, s.recordId, 'steward', 'manual', { via: 'profile-steward', kind: 'merge', reason: 'identical after re-filing' });
        return 'Merged with the same skill already filed there.';
      }
      break;
    }
    case 'merge':
      for (const id of s.removeIds ?? []) await deleteRecord(userId, id);
      break;
    case 'remove':
      await deleteRecord(userId, s.recordId);
      break;
    case 'move': {
      if (!s.moveTo) throw new Error('Nothing to move to.');
      const data: Record<string, unknown> = { ...s.moveTo.data };
      if (s.ask) {
        if (!given) throw new Error(`${s.ask.prompt} is needed first.`);
        data[s.ask.field] = given;
      }
      const form = formFor(s.moveTo.type);
      if (!form) throw new Error('That record type does not exist.');
      const values = Object.fromEntries(form.fields.map((f) => [f.name, asFormValue(data[f.name])]));
      try {
        await createTypedRecord(userId, s.moveTo.type, values);
      } catch (err) {
        // Already there under the new type: the move is only the deletion that remains.
        if (!(err instanceof DuplicateRecordError)) throw err;
      }
      await deleteRecord(userId, s.recordId);
      break;
    }
    case 'ask': {
      if (!s.ask) throw new Error('Nothing was asked.');
      if (!given) throw new Error('Type an answer first.');
      if (s.recordType === 'role') {
        await createBullet(userId, { roleId: s.recordId, action: given });
      } else {
        const list = formFor(s.recordType)?.fields.find((f) => f.name === s.ask!.field)?.kind === 'list';
        await patchRecord(userId, s.recordId, {
          [s.ask.field]: list ? given.split(',').map((x) => x.trim()).filter(Boolean) : given,
        });
      }
      break;
    }
  }

  await audit(userId, s.recordType === 'role' ? null : s.recordId, 'steward', 'manual', {
    via: 'profile-steward',
    kind: s.kind,
    origin: s.origin,
    title: s.title.slice(0, 200),
  });
  return s.kind === 'remove' || s.kind === 'merge' ? 'Removed.' : 'Saved.';
}

export async function dismissSuggestion(userId: string, suggestionId: string): Promise<void> {
  await db
    .insert(stewardDismissals)
    .values({ userId, suggestionId: suggestionId.slice(0, 40) })
    .onConflictDoNothing();
}

/* ------------------------------------------------------- the check at Save -- */

const FILLER = ['with ease', 'responsible for', 'various', 'etc', 'helped with', 'worked on', 'in charge of', 'duties included'];
const PERSONAL = new Set(['i', 'me', 'my', 'mine', 'we', 'our', 'you', 'your']);

/** Whether a line has the kind of wording problem worth a model call. Most do not. */
export function wordingNeedsReview(text: string): boolean {
  const t = text.trim();
  if (t.length < 15) return false;
  const w = words(t);
  if (w.some((x) => PERSONAL.has(x))) return true;
  if (WEAK_OPENERS.has(w[0] ?? '')) return true;
  const lower = t.toLowerCase();
  return FILLER.some((f) => lower.includes(f)) || /^[a-z]/.test(t);
}

const PROSE_FIELD: Record<string, string> = {
  project: 'description',
  summary: 'text',
  achievement: 'description',
  award: 'description',
  volunteering: 'description',
  'experience-bullet': 'text',
};

export interface SaveCheck {
  /** Things to know before saving — a duplicate, a spelling that will be normalised. */
  notes: string[];
  /** Proposed wording, which the user may take or leave. */
  rewrites: Array<{ field: string; from: string; to: string; reason: string }>;
}

/**
 * Checks a record the user is about to save, before it is saved.
 *
 * Never blocks: a model that is slow or down yields no rewrite, and the caller saves
 * as typed. The check is only ever advice.
 */
export async function checkCandidate(
  userId: string,
  type: string,
  values: Record<string, string>,
  recordId?: string | null,
): Promise<SaveCheck> {
  const notes: string[] = [];
  const rewrites: SaveCheck['rewrites'] = [];
  const profile = await loadStewardProfile(userId);
  const others = profile.records.filter((r) => r.id !== recordId);

  let data: Record<string, unknown>;
  if (type === 'experience-bullet') {
    const text = composeBulletText({ action: values.action ?? '', scale: values.scale, outcome: values.outcome });
    data = { roleId: values.roleId, text, action: values.action, scale: values.scale, outcome: values.outcome };
  } else {
    const form = formFor(type);
    if (!form) return { notes, rewrites };
    const raw = coerceFormValues(form, values);
    data = tidyRecordData(type, raw);
    if (type === 'skill' && raw.name !== data.name) notes.push(`It will be saved as “${String(data.name)}”, the usual spelling.`);

    if (type === 'skill') {
      const want = suggestedSkillCategory(String(data.name ?? ''));
      if (want && want !== data.category) {
        notes.push(`${String(data.name)} is usually filed under ${SKILL_CATEGORY_LABELS[want]}; you chose ${String(data.category)}.`);
      }
      const keys = new Set(skillKeys(String(data.name ?? '')));
      const same = others.filter((r) => r.type === 'skill' && skillKeys(String(r.data.name ?? '')).some((k) => keys.has(k)));
      if (same.length > 0) notes.push(`You already have ${same.map((r) => `“${String(r.data.name)}”`).join(', ')} — this would list the same skill twice.`);
    } else {
      const hash = hashContent(hashInput(form, data));
      if (others.some((r) => r.type === type && r.contentHash === hash)) notes.push('You already have this saved.');
    }
  }

  const field = PROSE_FIELD[type];
  const text = field ? String(data[field] ?? '') : '';
  const structuredBullet = type === 'experience-bullet' && (values.scale?.trim() || values.outcome?.trim());
  if (field && !structuredBullet && wordingNeedsReview(text)) {
    const candidate: StewardRecord = { id: 'candidate', type, source: 'manual', reviewState: 'approved', contentHash: 'candidate', data };
    const budget = new DraftBudget(DRAFT_BUDGET, 9_000, 500);
    try {
      await assertDailyBudget(userId);
      const { proposals } = await proposeChanges({ section: sectionOf(type), records: [candidate], roles: profile.roles, budget });
      const { suggestions } = verifyProposals(proposals, [candidate], profile.roles);
      for (const s of suggestions) {
        for (const [f, c] of Object.entries(s.changes ?? {})) {
          if (f === field && typeof c.to === 'string') {
            rewrites.push({ field: type === 'experience-bullet' ? 'action' : f, from: text, to: c.to, reason: s.reason });
          }
        }
      }
    } catch (err) {
      console.warn('[steward] save check skipped the model:', err instanceof Error ? err.message.slice(0, 200) : err);
    } finally {
      await recordDailyUsage(userId, budget.snapshot());
    }
  }
  return { notes, rewrites };
}

/* ------------------------------------------------------------ Add with AI -- */

export interface AssistantCandidate {
  key: string;
  type: string;
  label: string;
  record: Record<string, unknown>;
  /** Set when the profile already holds this. Unticked by default. */
  duplicateOf?: string;
}

export interface AssistantExtraction {
  records: AssistantCandidate[];
  roles: Array<{ key: string; title: string; company: string; startDate: string; endDate: string; bullets: string[] }>;
  dropped: string[];
  unplaced: string[];
}

export async function extractForProfile(userId: string, text: string): Promise<AssistantExtraction> {
  await assertDailyBudget(userId);
  const budget = new DraftBudget(DRAFT_BUDGET, REVIEW_TIME_BUDGET_MS, 1_000);
  try {
    const claim = await extractClaims({ text, budget });
    const grounded = groundClaims(claim, text);
    const payload = toCommitPayload(grounded);
    const profile = await loadStewardProfile(userId);

    const records: AssistantCandidate[] = payload.records.map((raw, i) => {
      const type = String(raw.type);
      const form = formFor(type);
      const record = tidyRecordData(type, raw);
      let duplicateOf: string | undefined;
      if (type === 'skill') {
        const keys = new Set(skillKeys(String(record.name ?? '')));
        const hit = profile.records.find((r) => r.type === 'skill' && skillKeys(String(r.data.name ?? '')).some((k) => keys.has(k)));
        if (hit) duplicateOf = String(hit.data.name);
      } else if (form) {
        const data = Object.fromEntries(form.fields.map((f) => [f.name, record[f.name]]).filter(([, v]) => v !== undefined && v !== ''));
        const hash = hashContent(hashInput(form, data));
        const hit = profile.records.find((r) => r.contentHash === hash);
        if (hit) duplicateOf = labelOf(hit);
      }
      const probe: StewardRecord = { id: `c${i}`, type, source: 'manual', reviewState: 'approved', contentHash: '', data: record };
      return { key: `r${i}`, type, label: labelOf(probe), record: { ...record, type }, duplicateOf };
    });

    return {
      records,
      roles: payload.roles.map((r, i) => ({
        key: `role${i}`,
        title: r.title,
        company: r.company,
        startDate: r.startDate,
        endDate: r.endDate,
        bullets: r.bullets.map((b) => b.text),
      })),
      dropped: grounded.dropped,
      unplaced: grounded.unplaced,
    };
  } finally {
    await recordDailyUsage(userId, budget.snapshot());
  }
}

export async function commitFromAssistant(userId: string, payload: unknown, prompt: string): Promise<string> {
  const parsed = CommitPayloadSchema.parse(payload);
  const summary = await commitImport(userId, { ...parsed, contact: null }, 'manual');
  await audit(userId, null, 'create', 'manual', {
    via: 'profile-assistant',
    prompt: prompt.slice(0, 1_000),
    created: summary.created,
    rolesCreated: summary.rolesCreated,
  });
  return summary.message;
}

/* --------------------------------------------------------- import review -- */

export interface ImportNote {
  /** What the profile already holds that this candidate repeats. */
  duplicateOf?: string;
  rewrite?: { field: string; to: string; reason: string };
}

/** Prose candidates the model is worth asking about, most valuable first. */
const IMPORT_PROSE: Record<string, string> = {
  'experience-bullet': 'text',
  project: 'description',
  summary: 'text',
  achievement: 'description',
  award: 'description',
};

/** How many import candidates one model call covers. One call: the importer has 30 s too. */
const IMPORT_MODEL_LIMIT = 12;

/**
 * The steward between an import and the profile — STEWARD.md §3, "where it sits" 3.
 *
 * Says which candidates the profile already holds, so they arrive unticked instead of
 * becoming a second copy of a career, and offers better wording for the lines that need
 * it. Nothing is written here: the importer still commits what the user ticks.
 */
export async function reviewImportCandidates(
  userId: string,
  candidates: Array<{ key: string; type: string; record: Record<string, unknown> }>,
): Promise<Record<string, ImportNote>> {
  const profile = await loadStewardProfile(userId);
  const notes: Record<string, ImportNote> = {};

  const bulletTexts = profile.records
    .filter((r) => r.type === 'experience-bullet')
    .map((r) => String(r.data.text ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim());

  for (const c of candidates) {
    const data = tidyRecordData(c.type, c.record);
    if (c.type === 'skill') {
      const keys = new Set(skillKeys(String(data.name ?? '')));
      const hit = profile.records.find((r) => r.type === 'skill' && skillKeys(String(r.data.name ?? '')).some((k) => keys.has(k)));
      if (hit) notes[c.key] = { duplicateOf: String(hit.data.name) };
      continue;
    }
    if (c.type === 'experience-bullet') {
      const text = String(data.text ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
      if (text && bulletTexts.includes(text)) notes[c.key] = { duplicateOf: 'a bullet already in your profile' };
      continue;
    }
    const form = formFor(c.type);
    if (!form) continue;
    const fields = Object.fromEntries(
      form.fields.map((f) => [f.name, data[f.name]]).filter(([, v]) => v !== undefined && v !== ''),
    );
    const hash = hashContent(hashInput(form, fields));
    const hit = profile.records.find((r) => r.contentHash === hash);
    if (hit) notes[c.key] = { duplicateOf: labelOf(hit) };
  }

  // Wording, for the lines that show a reason to ask.
  const prose = candidates
    .filter((c) => {
      const field = IMPORT_PROSE[c.type];
      return field && !notes[c.key]?.duplicateOf && wordingNeedsReview(String(c.record[field] ?? ''));
    })
    .slice(0, IMPORT_MODEL_LIMIT);

  if (prose.length > 0) {
    const records: StewardRecord[] = prose.map((c) => ({
      id: c.key,
      type: c.type,
      source: 'ai-import',
      reviewState: 'approved',
      contentHash: 'candidate',
      data: tidyRecordData(c.type, c.record),
    }));
    const budget = new DraftBudget(DRAFT_BUDGET, REVIEW_TIME_BUDGET_MS, 1_000);
    try {
      await assertDailyBudget(userId);
      const section = records[0].type === 'experience-bullet' ? 'experience' : 'projects';
      const { proposals } = await proposeChanges({ section, records, roles: profile.roles, budget });
      const { suggestions } = verifyProposals(proposals, records, profile.roles);
      for (const s of suggestions) {
        for (const [field, change] of Object.entries(s.changes ?? {})) {
          if (typeof change.to === 'string' && IMPORT_PROSE[s.recordType] === field) {
            notes[s.recordId] = { ...notes[s.recordId], rewrite: { field, to: change.to, reason: s.reason } };
          }
        }
      }
    } catch (err) {
      console.warn('[steward] import review skipped the model:', err instanceof Error ? err.message.slice(0, 200) : err);
    } finally {
      await recordDailyUsage(userId, budget.snapshot());
    }
  }

  return notes;
}
