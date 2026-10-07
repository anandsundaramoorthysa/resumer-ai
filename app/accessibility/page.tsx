import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalShell } from '@/components/legal-shell';
import { APP_NAME, EFFECTIVE_DATE, GRIEVANCE, SUPPORT_EMAIL } from '@/lib/legal/config';

export const metadata: Metadata = {
  title: 'Accessibility statement',
  description: `${APP_NAME} aims to meet WCAG 2.2 level AA. What is in place, what is not yet verified, and how to report a barrier.`,
};

export default function AccessibilityPage() {
  return (
    <LegalShell eyebrow="Legal" title="Accessibility statement" meta={`Last updated ${EFFECTIVE_DATE}`}>
      <p>
        We want {APP_NAME} to be usable by everyone, including people who use screen readers,
        keyboards, magnification or voice control. Our goal is to conform to the Web Content
        Accessibility Guidelines (WCAG) 2.2 at level AA.
      </p>

      <h2>Where we are</h2>
      <p>
        We have <strong>not yet had an independent accessibility audit</strong>, and we do not yet
        claim full conformance. What we build in:
      </p>
      <ul>
        <li>a &quot;skip to content&quot; link and a single main landmark on each page;</li>
        <li>the page language declared, one top-level heading per page and labelled form fields;</li>
        <li>full keyboard use of forms and buttons, and a visible focus indicator;</li>
        <li>touch targets of about 44 pixels for the main controls;</li>
        <li>light and dark themes you can switch from the page, and respect for your system setting;</li>
        <li>status and error messages announced to assistive technology on the sign-in, consent and account forms.</li>
      </ul>

      <h2>Known limitations</h2>
      <ul>
        <li>We have not run automated accessibility testing in our build pipeline yet, nor a full screen-reader review of every screen.</li>
        <li>Some data-heavy screens (resume editor, Job Radar timeline, activity tables) may be harder to use with assistive technology than the pages above.</li>
        <li>Resume files you export (PDF, DOCX) are laid out for applicant-tracking systems and are not guaranteed to meet PDF/UA or tagged-document accessibility standards.</li>
        <li>The service is in English only.</li>
      </ul>

      <h2>Tell us about a barrier</h2>
      <p>
        If something is hard or impossible to use, write to{' '}
        <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with the page and
        what went wrong, and the assistive technology you use if you are comfortable sharing it. We
        will acknowledge within {GRIEVANCE.acknowledgeDays} days and tell you what we can do. See also
        the <Link href="/contact" className="underline">contact page</Link>.
      </p>
    </LegalShell>
  );
}
