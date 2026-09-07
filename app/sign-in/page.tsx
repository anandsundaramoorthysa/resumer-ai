import { providerAvailability } from '@/auth';
import { Logo } from '@/components/logo';
import { isMailConfigured } from '@/lib/auth/mail';
import { SignInForm } from './sign-in-form';
import { oauthSignInAction } from './sign-in-actions';

export const metadata = { title: 'Sign in' };

/**
 * Rendered per request, not prerendered.
 *
 * This page asks three runtime questions — is GitHub configured, is Google configured,
 * can we send mail — and Next was prerendering it at build time, freezing the answers
 * into static HTML. The effect is a trap rather than a slow page: setting SMTP_USER or
 * AUTH_GOOGLE_ID in the host's dashboard changes nothing until someone happens to
 * redeploy, and until then the page says email sign-up is unavailable while /api/health
 * reports the provider working. That exact contradiction is how this was found.
 */
export const dynamic = 'force-dynamic';

/**
 * GitHub stays first, and says why.
 *
 * It is not merely another provider here: the same grant carries the repo access the
 * portfolio sync needs, so choosing it means one credential instead of two. Email and
 * Google exist because not everyone building a career has a GitHub account worth syncing
 * — an SEO or project-management profile has nothing in a repo.
 */
export default function SignInPage() {
  // In development the mailer logs the link to the server console instead of sending it,
  // so the flow is testable without a provider account. In production a form that cannot
  // deliver its confirmation link is worse than an absent one, so it is hidden.
  const passwordEnabled =
    providerAvailability.password &&
    (isMailConfigured() || process.env.NODE_ENV !== 'production');

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
        <Logo size={40} showWordmark={false} className="mb-5" />
        <h1 className="font-display text-2xl">Sign in to Resumer AI</h1>

        {providerAvailability.github ? (
          <>
            <p className="mt-2 text-sm text-muted">
              GitHub sign-in also grants the repo access used to keep your profile in
              sync, so there is no second credential to set up.
            </p>
            <form
              action={async () => {
                'use server';
                await oauthSignInAction('github');
              }}
            >
              <button
                type="submit"
                className="mt-5 min-h-11 w-full rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
              >
                Continue with GitHub
              </button>
            </form>
          </>
        ) : null}

        {providerAvailability.google ? (
          <form
            action={async () => {
              'use server';
              await oauthSignInAction('google');
            }}
          >
            <button
              type="submit"
              className="mt-3 min-h-11 w-full rounded-lg border border-line px-5 py-2.5 text-sm font-semibold hover:bg-paper"
            >
              Continue with Google
            </button>
          </form>
        ) : null}

        {passwordEnabled &&
        (providerAvailability.github || providerAvailability.google) ? (
          <div className="mt-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs text-muted">or use an email address</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        ) : null}

        <SignInForm passwordEnabled={passwordEnabled} />

        {!passwordEnabled ? (
          <p className="mt-5 text-xs text-muted">
            Email sign-up is off until a mail provider is configured — a confirmation link
            that cannot be sent is worse than not offering the option.
          </p>
        ) : null}

        <p className="mt-6 text-xs text-muted">
          Only read access is ever used — this app never writes to your repositories.
        </p>
      </div>
    </main>
  );
}
