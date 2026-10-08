import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalShell } from '@/components/legal-shell';
import {
  APP_NAME,
  EFFECTIVE_DATE,
  GEMINI_TIER,
  GRIEVANCE,
  MIN_AGE,
  OPERATOR,
  POLICY_VERSION,
  RETENTION,
} from '@/lib/legal/config';
import { AI_PROVIDERS, OTHER_PROCESSORS, TERMS_CHECKED, type SubProcessor } from '@/lib/legal/content';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: `How ${APP_NAME} collects, uses, shares and deletes your personal data, the providers that process it, and how to use your rights under India's DPDP Act.`,
};

function ProcessorTable({ rows, caption }: { rows: SubProcessor[]; caption: string }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="ledger min-w-[40rem] text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">What it receives from this app</th>
            <th scope="col">Where</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <th scope="row" className="align-top font-semibold normal-case tracking-normal text-ink">
                <a href={r.link} className="underline" rel="noopener noreferrer" target="_blank">
                  {r.name}
                </a>
                <span className="block font-normal text-muted">{r.role}</span>
              </th>
              <td className="align-top">{r.receives}</td>
              <td className="align-top">{r.where}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <LegalShell
      eyebrow="Legal"
      title="Privacy Policy"
      meta={`Version ${POLICY_VERSION} · effective ${EFFECTIVE_DATE}`}
    >
      <p>
        This explains what personal data {APP_NAME} holds about you, why, who else sees it, how long
        it is kept, and how to use your rights. It is written for India&apos;s Digital Personal Data
        Protection Act, 2023 (DPDP Act) and the Information Technology Act, 2000 and its rules. It is
        in plain English on purpose.
      </p>

      <h2>1. Who is responsible</h2>
      <p>
        {OPERATOR.name}, {OPERATOR.status}, runs {APP_NAME} and decides why and how your data is
        processed (the &quot;Data Fiduciary&quot; under the DPDP Act). Contact:{' '}
        <Link href="/contact" className="underline">the contact page</Link>. Grievance Officer:{' '}
        {GRIEVANCE.name}, <a className="underline" href={`mailto:${GRIEVANCE.email}`}>{GRIEVANCE.email}</a>.
      </p>

      <h2>2. What we collect</h2>
      <ul>
        <li>
          <strong>Account:</strong> your name, email address, whether the address is confirmed, a
          scrypt hash of your password (never the password), your GitHub username, the sign-in
          providers linked to the account and, for GitHub, an access token stored encrypted. Also the
          sign-up date, approval status and the date of the decision.
        </li>
        <li>
          <strong>Consent and access records:</strong> which policy version you accepted, when, and
          that you confirmed you are {MIN_AGE} or older; whether you used an invite code.
        </li>
        <li>
          <strong>Contact block:</strong> full name, email, phone, location and portfolio, GitHub and
          LinkedIn links you enter, printed at the top of your resumes.
        </li>
        <li>
          <strong>Profile:</strong> jobs, skills, achievements, projects, education and certifications
          you enter, import from a resume or LinkedIn export, or that are read from your portfolio
          repository; your answers to questions the app asks; suggestions you dismissed; a history of
          changes to your profile (audit log).
        </li>
        <li>
          <strong>Optional application answers:</strong> work authorisation, visa sponsorship need,
          equal-opportunity answers, salary expectation and notice period, if you fill them in. They
          are not used for any feature today.
        </li>
        <li>
          <strong>Resumes and jobs:</strong> the job postings (text or web address) you submit, the
          requirements read from them, every resume generated (content, score, file name) and the
          applications you track (role, company, status, dates).
        </li>
        <li>
          <strong>Job Radar:</strong> the searches made for you, the postings found, how they ranked
          and a log of each run.
        </li>
        <li>
          <strong>Operations:</strong> a record of each draft run (stages, timings, errors), daily AI
          usage counts, portfolio sync jobs (including repository text fetched during a sync), and
          GitHub App installation details (installation id, account name).
        </li>
        <li>
          <strong>Security records:</strong> sign-in, sign-up and reset attempt counters keyed by email
          address and IP address (kept about two days), and hashed single-use verification and reset
          tokens.
        </li>
        <li>
          <strong>Technical data:</strong> your host (Netlify) sees your IP address and request
          details; error reports may contain page addresses and browser type.
        </li>
      </ul>
      <p>We do not collect payment data, and we do not run advertising or analytics trackers.</p>

      <h2>3. Why, and on what basis</h2>
      <p>
        We use your data only to run the service you asked for: signing you in, building your profile,
        writing and scoring resumes for jobs you choose, finding jobs, protecting the service from
        abuse, and emailing you about your account. Our basis is your consent, which you give when you
        create the account (and again if this policy materially changes), and, where the DPDP Act
        allows it, legitimate uses such as complying with law and keeping the service secure. You can
        withdraw consent at any time (section 8); some processing, such as keeping security logs for
        the short period above, is not optional while you use the service.
      </p>

      <h2>4. Who receives your data</h2>
      <p>
        We do not sell your data. It is processed by the providers below, who act for us. A provider
        receives only what the table says.
      </p>
      <h3 className="mt-5 font-semibold">AI model providers</h3>
      <p>
        To read your resume, match it to a job and write bullets, we send text to AI model providers.
        We use five: Groq, Fireworks AI, Together AI, DeepInfra and Google (Gemini API). Each request
        goes to them in a fallback order, so any of them can receive your text. They are third-party
        services and we have no individual contract with them beyond their standard terms.
      </p>
      <p>
        <strong>What does reach the AI providers.</strong> When you import a resume, its raw text
        is sent to them <strong>including your name, email address, phone number and links</strong>,
        because the model has to read the document to extract them. Cover-letter prompts have your
        email, phone and profile links removed first, and the Job Radar search queries sent to SerpApi
        contain no name or contact details. If you click the evidence search on a profile bullet, your
        full name, employer and job title are sent as a web search through Firecrawl and your name is
        included in a prompt to an AI provider; this happens only when you click it. Anything else you
        type or paste (job text, answers, repository text) can be sent too, so do not paste anything
        you are not willing to have processed by these providers.
      </p>
      <p>
        <strong>Which providers.</strong> Unless the owner restricts it (the <code>AI_PII_PROVIDERS</code>{' '}
        setting limits which providers may receive prompts that carry personal data), any of the five
        providers, including Google&apos;s unpaid Gemini tier, may receive your resume. The owner can
        restrict this at any time. Under Google&apos;s unpaid terms, quoted below, Google may use and
        human-review submitted content.
      </p>
      <ProcessorTable rows={AI_PROVIDERS} caption="AI model providers and the data they receive" />
      <p>
        <strong>Their terms differ, and some are weaker than you might expect.</strong> As of{' '}
        {TERMS_CHECKED}, from the providers&apos; own pages (read them, they can change):
      </p>
      <ul>
        <li>
          <strong>Google Gemini API.</strong> Google&apos;s{' '}
          <a className="underline" href="https://ai.google.dev/gemini-api/terms" rel="noopener noreferrer" target="_blank">
            Gemini API Additional Terms
          </a>{' '}
          (last modified 2026-04-28) treat unpaid and paid services differently. For unpaid services
          Google says it uses submitted content and responses to &quot;provide, improve, and develop
          Google products and services&quot;, that &quot;human reviewers may read, annotate, and
          process your API input and output&quot; (after disconnecting it from your Google Account,
          API key and Cloud project), and tells developers: &quot;Do not submit sensitive,
          confidential, or personal information to the Unpaid Services.&quot; For paid services Google
          says it does not use prompts or responses to improve its products, and logs them for a
          limited period to detect abuse and meet legal requirements. We treat our Gemini access as{' '}
          <strong>{GEMINI_TIER}</strong>. {GEMINI_TIER === 'unpaid'
            ? 'That means text sent to Google could be used to improve Google products and read by human reviewers. Google is used only when other providers are unavailable.'
            : ''}
        </li>
        <li>
          <strong>Groq.</strong> Groq&apos;s{' '}
          <a className="underline" href="https://console.groq.com/docs/your-data" rel="noopener noreferrer" target="_blank">
            data page
          </a>{' '}
          says that by default it does not retain customer data for inference requests, except where
          needed to troubleshoot failures or investigate abuse (up to 30 days); customers can enable
          Zero Data Retention in their settings; customer data it retains is held in Google Cloud
          buckets in the United States. That page does not say whether Groq trains on customer data.
        </li>
        <li>
          <strong>Fireworks AI, Together AI, DeepInfra.</strong> Each publishes its own data-handling
          terms (linked in the table). We have not signed a separate data-processing agreement with
          any of the five providers.
        </li>
      </ul>
      <h3 className="mt-5 font-semibold">Other service providers</h3>
      <ProcessorTable rows={OTHER_PROCESSORS} caption="Other providers and the data they receive" />
      <p>We may also disclose data when the law requires it, for example to a court or a government authority.</p>

      <h2>5. Transfers outside India</h2>
      <p>
        Most of the providers above operate outside India, mainly in the United States, and Sentry
        reports go to the European Union. Your data is therefore transferred and processed abroad. The
        DPDP Act permits transfers except to countries the Government restricts; we will review this
        if a restriction applies to a provider we use.
      </p>

      <h2>6. How long we keep it</h2>
      <ul>
        <li>Account, profile, resumes, applications: until you delete your account. We review accounts inactive for {RETENTION.inactiveAccountMonths} months and delete them after notice; this review and deletion is currently a manual process (the system only produces a report).</li>
        <li>Draft run history: {RETENTION.runHistoryDays} days. Per-call AI telemetry (provider, model, token counts, timing, error class; no prompt text): {RETENTION.aiCallDays} days. Daily usage counts (calls and tokens per day, no prompt or resume text): {RETENTION.usageCountsMonths} months. Profile change log (audit log): {RETENTION.auditLogMonths} months, with any prompt text in it removed after {RETENTION.auditPromptDays} days.</li>
        <li>Job Radar run logs: {RETENTION.radarRunDays} days.</li>
        <li>Job search cache (not tied to your identity): {RETENTION.searchCacheHours} hours, and at most {RETENTION.searchCacheMaxDays} days.</li>
        <li>Accounts the owner did not approve: deleted automatically by a daily job {RETENTION.deniedAccountDays} days after the decision.</li>
        <li>Sign-in attempt counters: about two days. Verification and reset tokens: until they expire.</li>
        <li>
          When you delete your account, your data is erased from the live database immediately.
          Database backups that held it are purged within {RETENTION.backupPurgeDays} days. Copies at
          providers (for example an AI provider&apos;s abuse-review logs, up to 30 days at Groq) follow
          their own schedules and we cannot erase them ourselves.
        </li>
      </ul>

      <h2>7. Security</h2>
      <p>What we actually do:</p>
      <ul>
        <li>Passwords are stored only as scrypt hashes; reset and verification links are single-use and stored hashed.</li>
        <li>Your GitHub access token is encrypted at rest (AES-256-GCM).</li>
        <li>Connections use TLS (HTTPS), provided by our host.</li>
        <li>Sign-in, sign-up, reset and AI actions are rate limited; new accounts need approval before they can use AI features.</li>
        <li>Sessions last at most 7 days and are ended on every device when you change your password or choose &quot;Sign out of all devices&quot;.</li>
        <li>Error reports are scrubbed of tokens and keys and carry no session replay.</li>
      </ul>
      <p>
        Your resume content and contact details are stored in the database without field-level
        encryption; they are protected by the access controls of our database provider and our own
        code. No system is perfectly secure.
      </p>

      <h2>8. Your rights, and how to use them</h2>
      <p>Under the DPDP Act you can:</p>
      <ul>
        <li><strong>Access</strong> your data: <Link href="/settings/account" className="underline">Settings, Your account</Link>, &quot;Download JSON&quot; gives you a full copy.</li>
        <li><strong>Correct or update</strong> it: edit your profile and contact details in the app, or write to us.</li>
        <li><strong>Erase</strong> it: Settings, Your account, &quot;Delete my account&quot; removes your data immediately.</li>
        <li><strong>Withdraw consent</strong>: delete your account. This does not affect processing done before.</li>
        <li><strong>Nominate</strong> another person to exercise your rights if you die or become unable to: write to us with their details.</li>
        <li><strong>Complain</strong> to our Grievance Officer (below) first. If unresolved you may approach the Data Protection Board of India once it is operational.</li>
      </ul>
      <p>
        Grievances are acknowledged within {GRIEVANCE.acknowledgeDays} days and resolved within{' '}
        {GRIEVANCE.resolveDays} days: {GRIEVANCE.name},{' '}
        <a className="underline" href={`mailto:${GRIEVANCE.email}`}>{GRIEVANCE.email}</a>.
      </p>

      <h2>9. Children</h2>
      <p>
        {APP_NAME} is for people aged {MIN_AGE} and over. You confirm this when you sign up. We do not
        knowingly process children&apos;s data; if you think a child has an account, tell us and we
        will delete it.
      </p>

      <h2>10. Cookies and local storage</h2>
      <p>We use only strictly necessary cookies, so there is no cookie banner:</p>
      <ul>
        <li>Sign-in session and security cookies set by Auth.js (a session cookie, a CSRF cookie and a callback address cookie).</li>
        <li>A short-lived cookie that ties an email confirmation link to the browser that signed up.</li>
        <li>Two preference cookies, <code>theme</code> (light or dark) and <code>sidebar</code> (open or closed).</li>
      </ul>
      <p>
        The app also uses your browser&apos;s session storage briefly to carry a job from Job Radar to
        the resume drafter. Our error reporter (Sentry) is configured without cookies, session replay
        or analytics. We do not use advertising or analytics cookies.
      </p>

      <h2>11. If something goes wrong</h2>
      <p>
        If a personal data breach affects you, we will tell you and the Data Protection Board of India
        within the time required by law, and say what happened, what data was involved and what you
        can do.
      </p>

      <h2>12. Changes</h2>
      <p>
        If we change this policy in a way that matters, we change the version above and ask you to
        accept the new version the next time you sign in. Smaller corrections (typos, links) may be
        made without that.
      </p>

      <h2>13. Contact</h2>
      <p>
        Questions, requests and complaints: <Link href="/contact" className="underline">Contact</Link>.
      </p>
    </LegalShell>
  );
}
