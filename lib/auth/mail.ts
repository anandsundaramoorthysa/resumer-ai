/**
 * Sending the emails this product sends — through Gmail over SMTP (./smtp.ts).
 *
 * One way out, on purpose. A Gmail app password needs no domain and delivers to anyone,
 * which is what a product without its own sending domain needs; an HTTP email API sat
 * here too, took precedence whenever its key was set, and could only ever mail the
 * account holder until a domain was verified. Two senders meant two things to configure
 * and a quiet question of which one a message had actually gone through.
 *
 * The messages are plain text with the link on its own line. A link inside an HTML
 * button is the shape phishing takes, and a verification email that looks like phishing
 * gets ignored — which turns into "I never got the email".
 */

import 'server-only';
import { describeSmtpError, sendViaSmtp, smtpConfig, smtpTransport } from './smtp';

export interface MailResult {
  ok: boolean;
  /** Set when the mail could not be sent, for the caller to log rather than display. */
  error?: string;
  /** True when SMTP is not configured and the link was logged instead. */
  loggedOnly?: boolean;
}

export type MailProvider = 'smtp' | 'none';

/** Whether a message would go out right now: SMTP when SMTP_USER and SMTP_PASS are set. */
export function mailProvider(): MailProvider {
  return smtpConfig() ? 'smtp' : 'none';
}

export function isMailConfigured(): boolean {
  return mailProvider() !== 'none';
}

/** A one-line description of the mail setup, for the settings page and the setup check. */
export function describeMailProvider(): string {
  const c = smtpConfig();
  return c ? `SMTP via ${c.host}, sending as ${c.from}` : 'not configured';
}

async function deliver(to: string, subject: string, text: string, html?: string): Promise<MailResult> {
  const config = smtpConfig();

  // Without SMTP the link goes to the server log. In development that is the whole flow
  // working without an account anywhere; in production the sign-in page hides the email
  // option rather than offering one that would strand whoever used it.
  if (!config) {
    // The body holds a live verify/reset link, i.e. a credential. It is only ever logged
    // in development; in production nothing but the fact of the skip is recorded.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[mail] SMTP is not configured. To: ${to}\nSubject: ${subject}\n${text}`);
    } else {
      console.warn('[mail] SMTP is not configured; a message was not sent.');
    }
    return { ok: true, loggedOnly: true };
  }

  // With an html body the message goes out multipart (text + html); without one it is the
  // plain-text message it has always been.
  if (html) {
    try {
      await smtpTransport(config).sendMail({ from: config.from, to, subject, text, html });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeSmtpError(err) };
    }
  }
  const sent = await sendViaSmtp(config, to, subject, text);
  return sent.ok ? { ok: true } : { ok: false, error: sent.error };
}

/** A multipart (text + HTML) message built by lib/auth/templates.ts. */
export function sendTemplatedEmail(to: string, email: { subject: string; text: string; html: string }): Promise<MailResult> {
  return deliver(to, email.subject, email.text, email.html);
}

/** A plain-text notice to the site operator — draft-failure alerts (lib/server/draft-alerts.ts). */
export function sendOperatorEmail(to: string, subject: string, text: string): Promise<MailResult> {
  return deliver(to, subject, text);
}

export function appUrl(path: string): string {
  const base =
    process.env.AUTH_URL?.replace(/\/$/, '') ||
    process.env.NEXTAUTH_URL?.replace(/\/$/, '') ||
    'http://localhost:3000';
  return `${base}${path}`;
}

export async function sendVerificationEmail(to: string, token: string): Promise<MailResult> {
  const link = appUrl(`/verify-email?token=${encodeURIComponent(token)}`);
  return deliver(
    to,
    'Confirm your email for Resumer AI',
    [
      'Confirm this address to finish setting up your Resumer AI account.',
      '',
      link,
      '',
      'The link works once and expires in 24 hours.',
      '',
      'If you did not create an account, ignore this — nothing was set up, and the',
      'address will not be used again.',
    ].join('\n'),
  );
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<MailResult> {
  const link = appUrl(`/reset-password?token=${encodeURIComponent(token)}`);
  return deliver(
    to,
    'Reset your Resumer AI password',
    [
      'Use this link to set a new password.',
      '',
      link,
      '',
      'The link works once and expires in an hour.',
      '',
      'If you did not ask for this, you can ignore it. Your password has not changed',
      'and nobody can sign in without this link.',
    ].join('\n'),
  );
}
