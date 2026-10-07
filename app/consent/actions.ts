'use server';

import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { recordConsent } from '@/lib/legal/consent';

export interface ConsentResult {
  ok: boolean;
  message: string;
}

/** Records acceptance of the CURRENT policy version for the signed-in user, then continues. */
export async function acceptConsentAction(accepted: boolean): Promise<ConsentResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, message: 'Sign in first.' };
  if (accepted !== true) {
    return { ok: false, message: 'Confirm that you are 18 or older and agree to the Terms and Privacy Policy.' };
  }
  await recordConsent(session.user.id, { ageAttested: true, source: 'oauth-consent-page' });
  redirect('/');
}
