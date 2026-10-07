import { ThemeCorner } from '@/components/theme-corner';
import { providerAvailability } from '@/auth';
import { Logo } from '@/components/logo';
import { isMailConfigured } from '@/lib/auth/mail';
import { GitHubIcon, GoogleIcon } from '@/components/brand-icons';
import { SignInForm } from './sign-in-form';
import { oauthSignInAction } from './sign-in-actions';
import Link from 'next/link';
import { LegalFooter } from '@/components/legal-footer';
import { signupMode } from '@/lib/legal/config';
import { flagOn } from '@/lib/server/flags';
import { signInErrorMessage } from '@/lib/auth/signup-gate';

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
export default async function SignInPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const { error } = (await searchParams) ?? {};
  const errorMessage = error ? signInErrorMessage(error, await flagOn('signups_enabled')) : null;
  // In development the mailer logs the link to the server console instead of sending it,
  // so the flow is testable without a provider account. In production a form that cannot
  // deliver its confirmation link is worse than an absent one, so it is hidden.
  const passwordEnabled =
    providerAvailability.password &&
    (isMailConfigured() || process.env.NODE_ENV !== 'production');

  return (
    <main id="main" tabIndex={-1} className="grid min-h-screen min-h-dvh place-items-center px-5 pb-10 pt-16">
      <ThemeCorner />
      <div className="w-full max-w-md sheet p-5 text-center sm:p-8">
        <Logo size={40} showWordmark={false} className="mb-5" />
        <h1 className="font-display text-2xl text-balance">Sign in to Resumer AI</h1>
        {errorMessage && (
          <p role="alert" className="mt-2 border border-danger px-3 py-2 text-left text-sm text-danger">
            {errorMessage}
          </p>
        )}
        <p className="mt-2 border border-rule px-3 py-2 text-left text-sm">
          <strong>Access is by invite or owner approval.</strong> A valid invite code approves a new
          account straight away (up to a daily limit); otherwise the site owner approves it, because
          every account uses the same AI services.
        </p>
        <p className="consent-text mt-2 text-left text-xs text-muted">
          By continuing with GitHub, Google or email you confirm you are 18 or older and agree to the{' '}
          <Link href="/terms" className="underline">Terms</Link> and{' '}
          <Link href="/privacy" className="underline">Privacy Policy</Link>. Your resume and job text
          are processed by the AI providers listed there.
        </p>

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
                className="btn btn-primary mt-5 w-full px-3! text-sm sm:px-5! sm:text-base"
              >
                {/* Both icons sit in the same 24px box so the labels line up. */}
                <span className="grid h-6 w-6 shrink-0 place-items-center">
                  <GitHubIcon />
                </span>
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
              className="mt-3 btn w-full px-3! text-sm sm:px-5! sm:text-base"
            >
              {/* The Google mark's colours are only correct on a light ground, so it sits
                  on a white 2px-radius chip in both themes instead of the button turning
                  white in dark mode (keeps the button on the theme's own surface). */}
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-sm bg-white">
                <GoogleIcon />
              </span>
              Continue with Google
            </button>
          </form>
        ) : null}

        {passwordEnabled &&
        (providerAvailability.github || providerAvailability.google) ? (
          <div className="mt-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-rule" />
            <span className="text-xs text-muted">or use an email address</span>
            <span className="h-px flex-1 bg-rule" />
          </div>
        ) : null}

        <SignInForm passwordEnabled={passwordEnabled} inviteEnabled={signupMode() === 'invite'} />

        {!passwordEnabled ? (
          <p className="mt-5 text-xs text-muted">
            Email sign-up is off until a mail provider is configured — a confirmation link
            that cannot be sent is worse than not offering the option.
          </p>
        ) : null}

        <p className="mt-4 border-t border-line pt-4 text-xs text-muted">
          Only read access is ever used — this app never writes to your repositories.
        </p>
        <LegalFooter className="mt-2" />
      </div>
    </main>
  );
}
