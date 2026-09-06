'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { applicationFormFields } from '@/lib/db/schema';
import { EEO_QUESTIONS } from './questions';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Empty string means "not answered" and is stored as NULL, not as "". */
function orNull(value: FormDataEntryValue | null): string | null {
  const s = String(value ?? '').trim();
  return s ? s : null;
}

/**
 * REQ-1.3 — saves the reserved autofill answers.
 *
 * Nothing in the generator reads these. They are stored now so that Phase 10's browser
 * extension is a feature to build rather than a migration to run first, and because the
 * answers are tedious to retype and easy to get wrong under time pressure on a form.
 */
export async function saveApplicationFields(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: 'Sign in first.' };

  const sponsorship = String(formData.get('visaSponsorshipNeeded') ?? '');
  const eeoAnswers: Record<string, string> = {};
  for (const question of EEO_QUESTIONS) {
    const answer = orNull(formData.get(`eeo.${question.id}`));
    if (answer) eeoAnswers[question.id] = answer;
  }

  const values = {
    workAuthorization: orNull(formData.get('workAuthorization')),
    // Three states, not two: yes, no, and not answered. A checkbox would silently turn
    // "I haven't said" into "no", which is the wrong answer to put on an application.
    visaSponsorshipNeeded:
      sponsorship === 'yes' ? true : sponsorship === 'no' ? false : null,
    salaryExpectation: orNull(formData.get('salaryExpectation')),
    noticePeriod: orNull(formData.get('noticePeriod')),
    eeoAnswers: Object.keys(eeoAnswers).length > 0 ? eeoAnswers : null,
  };

  try {
    await db
      .insert(applicationFormFields)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: applicationFormFields.userId, set: values });
  } catch (err) {
    return {
      ok: false,
      message: `Could not save: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`,
    };
  }

  revalidatePath('/settings/application');
  return { ok: true, message: 'Saved. Nothing else reads these yet — see the note above.' };
}

/** Clears every answer. Offered because this is the most personal data the app holds. */
export async function clearApplicationFields(): Promise<ActionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: 'Sign in first.' };

  await db
    .insert(applicationFormFields)
    .values({
      userId,
      workAuthorization: null,
      visaSponsorshipNeeded: null,
      salaryExpectation: null,
      noticePeriod: null,
      eeoAnswers: null,
    })
    .onConflictDoUpdate({
      target: applicationFormFields.userId,
      set: {
        workAuthorization: null,
        visaSponsorshipNeeded: null,
        salaryExpectation: null,
        noticePeriod: null,
        eeoAnswers: null,
      },
    });

  revalidatePath('/settings/application');
  return { ok: true, message: 'Cleared. Nothing is stored for these fields now.' };
}
