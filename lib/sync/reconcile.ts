/**
 * Reconciliation — REQ-2.4.
 *
 * Policy, stated once and enforced here:
 *   - manual records are NEVER touched by sync, under any circumstance
 *   - new github-sync content is added automatically
 *   - changed github-sync content is updated automatically
 *   - content that vanished from source is FLAGGED, never deleted
 *
 * The flag-don't-delete rule exists because the parser is fallible. A parsing miss
 * should cost you a review prompt, not a section of your career history.
 */

import { createHash } from 'node:crypto';
import type { ProfileRecord, RecordSource } from '../types';

export function hashContent(parts: Array<string | undefined>): string {
  return createHash('sha256')
    .update(parts.filter(Boolean).join('').toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 32);
}

/** A record as produced by the parser, before it has an id. */
export type ParsedRecord = Omit<
  ProfileRecord,
  'id' | 'userId' | 'createdAt' | 'updatedAt' | 'flaggedForRemoval' | 'source'
> & { source?: RecordSource };

export interface ReconcilePlan {
  toInsert: ParsedRecord[];
  toUpdate: Array<{ id: string; parsed: ParsedRecord }>;
  toFlag: Array<{ id: string; reason: string }>;
  unchanged: number;
  /** Never populated — kept explicit so the "no deletes" policy is visible in the type. */
  toDelete: never[];
}

export function reconcile(
  existing: ProfileRecord[],
  parsed: ParsedRecord[],
): ReconcilePlan {
  const plan: ReconcilePlan = {
    toInsert: [],
    toUpdate: [],
    toFlag: [],
    unchanged: 0,
    toDelete: [],
  };

  const syncedExisting = existing.filter((r) => r.source === 'github-sync');
  const existingByHash = new Map(syncedExisting.map((r) => [r.contentHash, r]));
  const parsedHashes = new Set(parsed.map((p) => p.contentHash));

  // Manual records are invisible to this whole process by construction — they are
  // never read into any of the maps above, so nothing here can act on them.

  for (const p of parsed) {
    const match = existingByHash.get(p.contentHash);
    if (match) {
      plan.unchanged += 1;
      // Content identical, but tags may have been re-derived — refresh those.
      if (!sameTags(match.tags, p.tags)) {
        plan.toUpdate.push({ id: match.id, parsed: p });
      }
      continue;
    }

    // Same logical item, changed content? Match on a stable identity key.
    const identityMatch = syncedExisting.find(
      (e) => identityKey(e) === identityKey(p as unknown as ProfileRecord),
    );
    if (identityMatch) {
      plan.toUpdate.push({ id: identityMatch.id, parsed: p });
    } else {
      plan.toInsert.push(p);
    }
  }

  // Anything synced that no longer appears in source gets flagged for review.
  for (const e of syncedExisting) {
    if (parsedHashes.has(e.contentHash)) continue;
    const stillPresentByIdentity = parsed.some(
      (p) => identityKey(p as unknown as ProfileRecord) === identityKey(e),
    );
    if (stillPresentByIdentity) continue;
    if (e.flaggedForRemoval) continue;
    plan.toFlag.push({
      id: e.id,
      reason: 'No longer found in your portfolio source.',
    });
  }

  return plan;
}

/** Stable identity for "same item, edited" detection. */
function identityKey(r: ProfileRecord): string {
  switch (r.type) {
    case 'skill':
      return `skill:${r.name.toLowerCase().trim()}`;
    case 'project':
      return `project:${r.name.toLowerCase().trim()}`;
    case 'education':
      return `education:${r.institution.toLowerCase().trim()}:${r.credential.toLowerCase().trim()}`;
    case 'certification':
      return `cert:${r.name.toLowerCase().trim()}`;
    case 'achievement':
      return `achievement:${r.title.toLowerCase().trim()}`;
    case 'experience-bullet':
      // Bullets have no natural key; first 40 chars of the action is a decent proxy.
      return `bullet:${r.action.toLowerCase().trim().slice(0, 40)}`;
  }
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].map((t) => t.toLowerCase()).sort();
  const sb = [...b].map((t) => t.toLowerCase()).sort();
  return sa.every((t, i) => t === sb[i]);
}

export function summarizePlan(plan: ReconcilePlan): string {
  const bits: string[] = [];
  if (plan.toInsert.length) bits.push(`${plan.toInsert.length} added`);
  if (plan.toUpdate.length) bits.push(`${plan.toUpdate.length} updated`);
  if (plan.toFlag.length) bits.push(`${plan.toFlag.length} flagged for review`);
  if (bits.length === 0) return 'Already up to date';
  return bits.join(', ');
}
