'use server';

/**
 * The profile steward's server actions — thin wrappers over lib/server/steward.ts that add
 * the session and turn failures into sentences. See STEWARD.md.
 */

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { BudgetExceededError } from '@/lib/ai/budget';
import { MAX_CLAIM_CHARS, MIN_CLAIM_CHARS } from '@/lib/profile/claim';
import { DuplicateRecordError } from '@/lib/profile/records';
import {
  StaleSuggestionError,
  applySuggestion,
  checkCandidate,
  commitFromAssistant,
  dismissSuggestion,
  extractForProfile,
  reviewSection,
  type AssistantExtraction,
  type ReviewDepth,
  type ReviewPage,
  type SaveCheck,
} from '@/lib/server/steward';
import type { StewardSection, Suggestion } from '@/lib/steward/types';

export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; message: string };

class UserFacingError extends Error {}

async function userId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new UserFacingError('Sign in first.');
  return id;
}

/** Errors the writers throw on purpose already read as sentences; the rest are logged. */
const WRITER_MESSAGES = /required|longer than|not a valid|no longer exists|needed first|Type an answer|cannot be|Nothing to move|Nothing was asked/i;

function sentence(err: unknown): string {
  if (err instanceof UserFacingError || err instanceof StaleSuggestionError || err instanceof DuplicateRecordError) {
    return err.message;
  }
  if (err instanceof BudgetExceededError && err.scope === 'daily') {
    return 'Today’s AI allowance is used up. Checks that need no AI still run; try the rest tomorrow.';
  }
  // Too fast, or an account still waiting for approval: each already says what to do.
  if (err instanceof BudgetExceededError && (err.scope === 'rate' || err.scope === 'approval')) return err.message;
  if (err instanceof Error && WRITER_MESSAGES.test(err.message)) return err.message;
  console.error('[steward-actions]', err);
  return 'That did not work just now. Try again in a moment.';
}

const SECTIONS = new Set<StewardSection>(['skills', 'experience', 'projects', 'credentials', 'other']);

export async function reviewSectionAction(
  section: StewardSection,
  batch: number,
  /** 'deep' also asks about entries that already look complete — see ReviewDepth. */
  depth: ReviewDepth = 'normal',
): Promise<ActionResult<ReviewPage>> {
  try {
    if (!SECTIONS.has(section) || !Number.isInteger(batch) || batch < 0 || batch > 50) {
      throw new UserFacingError('Unknown section.');
    }
    if (depth !== 'normal' && depth !== 'deep') throw new UserFacingError('Unknown depth.');
    return { ok: true, data: await reviewSection(await userId(), section, batch, depth) };
  } catch (err) {
    return { ok: false, message: sentence(err) };
  }
}

export async function applySuggestionAction(
  suggestion: Suggestion,
  answer?: string,
): Promise<ActionResult> {
  try {
    const message = await applySuggestion(await userId(), suggestion, answer);
    revalidatePath('/profile');
    return { ok: true, data: undefined, message };
  } catch (err) {
    return { ok: false, message: sentence(err) };
  }
}

/**
 * Several quick fixes in one request; each succeeds or fails on its own.
 *
 * No revalidatePath here: in a server action it re-renders the whole profile page into
 * the response, and the browser sends several of these in a row. The page refreshes once,
 * after the last one (profile-assistant.tsx).
 */
export async function applyQuickFixesAction(
  suggestions: Suggestion[],
): Promise<ActionResult<{ applied: string[]; failed: number }>> {
  try {
    const id = await userId();
    const applied: string[] = [];
    let failed = 0;
    // Twelve, which is what the page sends (profile-assistant.tsx) and what the timing
    // work in STEWARD.md §4 found fits one request. Sixty did not.
    for (const s of suggestions.slice(0, 12)) {
      if (s.kind !== 'fix' || !s.quick || s.origin !== 'rule') {
        failed++;
        continue;
      }
      try {
        await applySuggestion(id, s);
        applied.push(s.id);
      } catch {
        failed++;
      }
    }
    return { ok: true, data: { applied, failed } };
  } catch (err) {
    return { ok: false, message: sentence(err) };
  }
}

export async function dismissSuggestionAction(suggestionId: string): Promise<ActionResult> {
  try {
    await dismissSuggestion(await userId(), suggestionId);
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, message: sentence(err) };
  }
}

/** Advice before a save. If it cannot run, the form saves as typed. */
export async function checkRecordAction(
  type: string,
  values: Record<string, string>,
  recordId?: string | null,
): Promise<ActionResult<SaveCheck>> {
  try {
    return { ok: true, data: await checkCandidate(await userId(), type, values, recordId) };
  } catch (err) {
    return { ok: false, message: sentence(err) };
  }
}

export async function extractForProfileAction(text: string): Promise<ActionResult<AssistantExtraction>> {
  try {
    const t = (text ?? '').trim();
    if (t.length < MIN_CLAIM_CHARS) {
      throw new UserFacingError('Say a little more — which skill, project or role, and what you did.');
    }
    if (t.length > MAX_CLAIM_CHARS) {
      throw new UserFacingError(`Keep it under ${MAX_CLAIM_CHARS} characters, or add it in parts.`);
    }
    return { ok: true, data: await extractForProfile(await userId(), t) };
  } catch (err) {
    return { ok: false, message: sentence(err) };
  }
}

export async function commitFromAssistantAction(payload: unknown, prompt: string): Promise<ActionResult> {
  try {
    const message = await commitFromAssistant(await userId(), payload, prompt ?? '');
    revalidatePath('/profile');
    revalidatePath('/');
    return { ok: true, data: undefined, message };
  } catch (err) {
    return { ok: false, message: sentence(err) };
  }
}
