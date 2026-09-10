import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { applicationFormFields } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { availableProviders } from '@/lib/ai/models';
import { ApplicationFieldsForm } from './application-form';
import { PasswordStatusCard } from '@/components/password-status-card';

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

  // Named from the same list the chain actually routes through, so the disclosure below
  // says what this deployment does rather than what the code could do with other keys.
  const providers = availableProviders();
  const providerNames = providers.map((p) => p.label);
  const providerList =
    providerNames.length > 1
      ? `${providerNames.slice(0, -1).join(', ')} and ${providerNames[providerNames.length - 1]}`
      : (providerNames[0] ?? '');

  return (
    <div className="min-h-screen min-h-dvh">
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
            provider — unlike the rest of your profile, which is; see{' '}
            <a href="#where-your-data-goes" className="font-semibold text-ink underline">
              Where your data goes
            </a>{' '}
            below. It is stored now so the planned browser-extension autofill can be built
            later without a database migration — and because these answers are tedious to
            retype and easy to fumble at the end of a long form. Filling this in is
            optional and changes nothing about what the app does today.
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

        {/*
          * The data-sharing disclosure.
          *
          * It lives on this page because this is where the app already made a claim
          * about AI providers — "it is never sent to an AI provider", said of one field
          * — and a sentence like that only means anything if the reader can find out
          * what IS sent, and to whom. Nothing else in the UI named a single recipient.
          *
          * The provider names come from `availableProviders()` rather than a hardcoded
          * list, so this cannot drift out of date the way a written list would when a
          * key is added or removed.
          */}
        <section
          id="where-your-data-goes"
          className="mt-10 scroll-mt-20 rounded-xl border border-line bg-surface p-5"
        >
          <h2 className="font-display text-lg">Where your data goes</h2>

          {providers.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              No AI provider is configured on this deployment, so nothing is being sent to
              one — and drafting will not work until a key is added. When one is
              configured this section names it.
            </p>
          ) : (
            <div className="mt-3 max-w-prose space-y-3 text-sm text-muted">
              <p>
                Drafting a resume sends your profile to a third-party AI company. That
                means your name, email address, phone number and location, every employer,
                job title and set of dates, and the full text of every bullet, project,
                qualification and skill you have saved — together with the job description
                you paste in. Syncing a portfolio repository sends the contents of the
                files it reads; importing a resume sends that document&apos;s text.
              </p>
              <p>
                {providers.length === 1 ? (
                  <>
                    On this deployment that company is{' '}
                    <strong className="text-ink">{providerList}</strong>.
                  </>
                ) : (
                  <>
                    On this deployment the request goes to one of{' '}
                    <strong className="text-ink">{providerList}</strong>. They are tried in
                    that order, and a request that is refused, rate-limited or too slow is
                    retried on the next one — so which company handles a given draft
                    depends on which was answering at that moment. You cannot pick one,
                    and the app cannot tell you in advance which it will be.
                  </>
                )}
              </p>
              <p>
                If you hand the app a link to a job posting instead of pasting the text,
                the link is sent to <strong className="text-ink">Firecrawl</strong>, which
                fetches the page and returns what it finds there.
              </p>
              <p>
                None of these companies has a data-processing agreement with Resumer AI.
                They are used through their public APIs on their own published terms, so
                what each of them keeps, for how long, and whether they train on it is set
                by that provider and not by this app. The only real control this gives you
                is over what you put in your profile in the first place.
              </p>
            </div>
          )}
        </section>

        <PasswordStatusCard />
      </main>
    </div>
  );
}
