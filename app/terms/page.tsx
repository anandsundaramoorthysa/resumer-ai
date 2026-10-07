import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalShell } from '@/components/legal-shell';
import { APP_NAME, EFFECTIVE_DATE, GRIEVANCE, JURISDICTION_CITY, MIN_AGE, OPERATOR, TERMS_VERSION } from '@/lib/legal/config';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: `The rules for using ${APP_NAME}: what the service is, how AI-assisted output should be used, acceptable use, accounts and invites, your content, and liability.`,
};

export default function TermsPage() {
  return (
    <LegalShell eyebrow="Legal" title="Terms of Service" meta={`Version ${TERMS_VERSION} · effective ${EFFECTIVE_DATE}`}>
      <p>
        These terms are an agreement between you and {OPERATOR.name}, {OPERATOR.status}
        (&quot;we&quot;), for your use of {APP_NAME}. By creating an account or signing in you agree to
        them and to the <Link href="/privacy" className="underline">Privacy Policy</Link>. If you do
        not agree, do not use the service.
      </p>

      <h2>1. The service</h2>
      <p>
        {APP_NAME} helps you build a profile of your own work history, import it from a resume or
        portfolio, match it to job postings, draft resumes and cover material from it, track
        applications and find job listings. It is a drafting tool. It is provided free of charge for
        now, with usage limits, and may change or stop.
      </p>

      <h2>2. AI-assisted output</h2>
      <p>
        Drafts are produced with the help of AI models. They can be wrong, incomplete or badly
        phrased. We design the service so that it does not invent facts that are not in your profile,
        but that is a design goal, not a guarantee. Scores and keyword matches are estimates, not
        predictions of any employer&apos;s decision. <strong>You are responsible for checking every
        resume and message before you send it</strong> and for what you tell employers. Job listings
        come from third-party sources and may be out of date or inaccurate. Nothing here is career,
        legal or financial advice.
      </p>

      <h2>3. Who may use it</h2>
      <p>
        You must be {MIN_AGE} or older. You must give accurate sign-up details and keep your password
        safe. You are responsible for activity on your account. One person, one account.
      </p>

      <h2>4. Accounts, invites and approval</h2>
      <p>
        Access is limited because every account uses paid third-party AI services. A new account is
        approved either by redeeming a valid invite code (while the daily limit for automatic
        approvals has not been reached) or by the owner by hand. We can approve, deny or revoke an
        account at our discretion, and we will email you about the decision. Invite codes are not
        transferable for payment and may be disabled at any time.
      </p>

      <h2>5. Usage limits</h2>
      <p>
        There are daily and short-term limits on AI actions, searches and other features, and an
        overall limit on the service. We may change them, and a feature may be unavailable when a
        limit or a provider is exhausted.
      </p>

      <h2>6. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>enter or upload personal data of other people without a right to do so, or anything unlawful, defamatory or infringing;</li>
        <li>present false qualifications or experience as true;</li>
        <li>scrape, crawl or bulk-extract the service, run automated requests beyond normal use, or try to get around limits, approval or security;</li>
        <li>probe for vulnerabilities outside responsible reporting (see the <Link href="/contact" className="underline">contact page</Link>), or disrupt the service or other users;</li>
        <li>resell the service or use it to build a competing dataset;</li>
        <li>use another person&apos;s account or invite code.</li>
      </ul>

      <h2>7. Your content</h2>
      <p>
        You own the profile, resume text and other content you provide, and the resumes made from
        them. You give us a limited, non-exclusive licence to store, copy and process that content,
        including by sending it to the service providers named in the Privacy Policy, only to run the
        service for you. We do not claim ownership of it and do not sell it. Our software, design and
        the service itself remain ours (see the licence files in the project).
      </p>

      <h2>8. Third-party services</h2>
      <p>
        The service depends on third parties (hosting, database, AI providers, GitHub, Google and
        others). We are not responsible for their availability or conduct. When you sign in with
        GitHub or Google, their terms also apply to your use of those accounts.
      </p>

      <h2>9. No warranty</h2>
      <p>
        The service is provided &quot;as is&quot; and &quot;as available&quot;. To the extent the law
        allows, we do not promise that it will be uninterrupted, error-free or secure, that drafts
        will be accurate, or that using it will get you an interview or a job.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect or consequential loss, lost
        opportunities or lost data, and our total liability to you for anything arising from the
        service is limited to the amount you paid us for it, which at present is nothing. Nothing in
        these terms excludes liability that cannot be excluded by law.
      </p>

      <h2>11. Ending your use</h2>
      <p>
        You can stop at any time and delete your account in{' '}
        <Link href="/settings/account" className="underline">Settings, Your account</Link>. We may
        suspend or end an account that breaks these terms, puts the service or others at risk, or has
        been inactive for the period in the Privacy Policy. Sections that by their nature continue
        (such as 7, 9, 10 and 13) survive ending.
      </p>

      <h2>12. Changes</h2>
      <p>
        We may update these terms. If a change is material we change the version above and ask you to
        accept it again before you continue. Using the service after that means you accept the new
        terms.
      </p>

      <h2>13. Governing law and courts</h2>
      <p>
        These terms are governed by the laws of India. Courts at {JURISDICTION_CITY} have exclusive
        jurisdiction over disputes, subject to any right you have under law to go elsewhere. Please
        raise a complaint with the Grievance Officer first ({GRIEVANCE.email}); we aim to resolve
        complaints within {GRIEVANCE.resolveDays} days.
      </p>

      <h2>14. Contact</h2>
      <p>
        <Link href="/contact" className="underline">Contact page</Link>.
      </p>
    </LegalShell>
  );
}
