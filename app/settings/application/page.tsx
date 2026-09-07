import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { applicationFormFields } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { ApplicationFieldsForm } from './application-form';

export const metadata = { title: 'Application answers' };
export const dynamic = 'force-dynamic';

export default async function ApplicationFieldsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');

  const [row] = await db
    .select()
    .from(applicationFormFields)
    .where(eq(applicationFormFields.userId, session.user.id))
    .limit(1);

  return (
    <div className="min-h-screen">
      <AppHeader current="/settings/application" width="3xl" />

      <main className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="font-display text-3xl">Application answers</h1>
        <p className="mt-2 text-sm text-muted">
          The questions every application portal asks that have nothing to do with your
          resume — work authorization, sponsorship, salary, notice, and the voluntary
          self-identification block.
        </p>

        {/*
          REQ-1.3 says these fields exist from the initial schema and stay unused until
          Phase 10. Saying so plainly is the point: a settings screen that looks like it
          does something and doesn't is worse than one that admits it.
        */}
        <div className="mt-5 rounded-xl border border-gold bg-gold-tint/40 p-4">
          <h2 className="text-sm font-semibold text-gold">Nothing reads these yet</h2>
          <p className="mt-1 text-sm text-muted">
            No resume, cover letter or export uses any of it, and it is never sent to an AI
            provider. It is stored now so the planned browser-extension autofill can be
            built later without a database migration — and because these answers are
            tedious to retype and easy to fumble at the end of a long form. Filling this in
            is optional and changes nothing about what the app does today.
          </p>
        </div>

        <ApplicationFieldsForm
          values={{
            workAuthorization: row?.workAuthorization ?? null,
            visaSponsorshipNeeded: row?.visaSponsorshipNeeded ?? null,
            salaryExpectation: row?.salaryExpectation ?? null,
            noticePeriod: row?.noticePeriod ?? null,
            eeoAnswers: row?.eeoAnswers ?? null,
          }}
        />
      </main>
    </div>
  );
}
