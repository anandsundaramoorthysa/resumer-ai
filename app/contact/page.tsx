import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalShell } from '@/components/legal-shell';
import { APP_NAME, GRIEVANCE, OPERATOR, SECURITY_EMAIL, SUPPORT_EMAIL } from '@/lib/legal/config';

export const metadata: Metadata = {
  title: 'Contact and grievances',
  description: `How to reach ${APP_NAME} for support, privacy requests, complaints (Grievance Officer) and security reports, and what response to expect.`,
};

export default function ContactPage() {
  return (
    <LegalShell eyebrow="Help" title="Contact and grievances">
      <h2>Support</h2>
      <p>
        Questions about your account or the service:{' '}
        <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. {APP_NAME} is run
        by one person, so replies are best-effort; there is no service-level agreement. Please do not
        send passwords or full resumes by email.
      </p>

      <h2>Grievance Officer</h2>
      <p>
        For complaints about how your personal data is handled, and for requests to access, correct
        or erase it, or to nominate someone, under the Digital Personal Data Protection Act, 2023:
      </p>
      <ul>
        <li><strong>Name:</strong> {GRIEVANCE.name}, {GRIEVANCE.title} ({OPERATOR.status})</li>
        <li><strong>Email:</strong> <a className="underline" href={`mailto:${GRIEVANCE.email}`}>{GRIEVANCE.email}</a></li>
        <li><strong>Acknowledgement:</strong> within {GRIEVANCE.acknowledgeDays} days of your message</li>
        <li><strong>Resolution:</strong> within {GRIEVANCE.resolveDays} days</li>
      </ul>
      <p>
        You can already download or delete your data yourself in{' '}
        <Link href="/settings/account" className="underline">Settings, Your account</Link>. If we do
        not resolve your complaint you may approach the Data Protection Board of India once it is
        operational.
      </p>

      <h2>Report abuse or a security problem</h2>
      <p>
        To report a security vulnerability, a leaked credential or abuse of the service, write to{' '}
        <a className="underline" href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a> with the subject
        &quot;Security&quot;. Tell us what you found and how to reproduce it. Please give us a
        reasonable time to fix it before you share it, do not access other people&apos;s data, and do
        not disrupt the service. We will acknowledge within {GRIEVANCE.acknowledgeDays} days. We do
        not run a paid bounty programme.
      </p>

      <h2>Legal</h2>
      <p>
        <Link href="/privacy" className="underline">Privacy Policy</Link> ·{' '}
        <Link href="/terms" className="underline">Terms of Service</Link> ·{' '}
        <Link href="/accessibility" className="underline">Accessibility</Link>
      </p>
    </LegalShell>
  );
}
