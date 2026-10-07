import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AppHeader } from '@/components/app-header';
import { LegalFooter } from '@/components/legal-footer';
import { hasCurrentConsent } from '@/lib/legal/consent';
import { EFFECTIVE_DATE } from '@/lib/legal/config';
import { ConsentForm } from './consent-form';

export const metadata = { title: 'Terms and privacy', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * Where a signed-in account lands until it has accepted the CURRENT policy version
 * (lib/server/approval.ts sends it here). It checks the session and the consent record
 * only, never approval, so it can neither loop with /pending nor be blocked by it: a
 * signed-in user who already consented is sent on to "/", and everyone else stays here.
 */
export default async function ConsentPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  if (await hasCurrentConsent(session.user.id)) redirect('/');

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader width="6xl" />
      <main id="main" tabIndex={-1} className="mx-auto max-w-lg px-5 py-16">
        <p className="eyebrow">Before you continue</p>
        <h1 className="mt-2 font-display text-3xl tracking-tight">Terms and privacy</h1>
        <p className="mt-4 max-w-prose text-muted">
          Resumer AI turns your profile and a job posting into a resume. To do that it stores what
          you give it and sends your resume and job text to the AI providers named in the Privacy
          Policy (effective {EFFECTIVE_DATE}). You can withdraw consent at any time by deleting your
          account.
        </p>
        <ConsentForm />
        <LegalFooter className="mt-10" />
      </main>
    </div>
  );
}
