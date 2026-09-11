/**
 * Sending the two emails this product sends.
 *
 * Two ways out, picked by whichever is configured:
 *
 *   - **SMTP** (`lib/auth/smtp.ts`), which with a Gmail app password needs no domain and
 *     will deliver to anyone. This is the option that works when you do not own a domain.
 *   - **Resend** over its HTTP API, called with `fetch` — no SDK, because the integration
 *     is one POST and a dependency would be more code than the thing it wraps. Needs a
 *     verified domain before it will mail anyone but the account holder.
 *
 * Resend wins when both are set. A verified sending domain has SPF, DKIM and a warmed
 * reputation behind it; Gmail-as-a-service has none of that and a 500-a-day ceiling, so
 * it is the fallback rather than the preference.
 *
 * Both messages are plain text with the link on its own line. A link inside an HTML
 * button is the shape phishing takes, and a verification email that looks like phishing
 * gets ignored — which turns into "I never got the email".
 */

import 'server-only';
import { sendViaSmtp, smtpConfig } from './smtp';

export interface MailResult {
  ok: boolean;
  /** Set when the mail could not be sent, for the caller to log rather than display. */
  error?: string;
  /** True when no provider is configured and the link was logged instead. */
  loggedOnly?: boolean;
}

export type MailProvider = 'resend' | 'smtp' | 'none';

function resendConfig() {
  return {
    apiKey: process.env.RESEND_API_KEY?.trim() || '',
    from: process.env.EMAIL_FROM?.trim() || '',
  };
}

/** Which provider a message would go out through right now. */
export function mailProvider(): MailProvider {
  const { apiKey, from } = resendConfig();
  if (apiKey && from) return 'resend';
  if (smtpConfig()) return 'smtp';
  return 'none';
}

export function isMailConfigured(): boolean {
  return mailProvider() !== 'none';
}

/** A one-line description of the mail setup, for the settings page and the setup check. */
export function describeMailProvider(): string {
  switch (mailProvider()) {
    case 'resend':
      return `Resend, sending as ${resendConfig().from}`;
    case 'smtp': {
      const c = smtpConfig()!;
      return `SMTP via ${c.host}, sending as ${c.from}`;
    }
    default:
      return 'not configured';
  }
}

async function deliver(to: string, subject: string, text: string): Promise<MailResult> {
  const provider = mailProvider();

  // With no provider the link goes to the server log. In development that is the whole
  // flow working without an account anywhere; in production the sign-in page hides the
  // email option rather than offering one that would strand whoever used it.
  if (provider === 'none') {
    console.warn(`[mail] no provider configured. To: ${to}\nSubject: ${subject}\n${text}`);
    return { ok: true, loggedOnly: true };
  }

  if (provider === 'smtp') {
    const sent = await sendViaSmtp(smtpConfig()!, to, subject, text);
    return sent.ok ? { ok: true } : { ok: false, error: sent.error };
  }

  const { apiKey, from } = resendConfig();
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // The sandbox refusal is the one people hit first, and Resend's own wording does
      // not say what to do about it.
      const detail = /testing emails|own email address/i.test(body)
        ? 'Resend is still in sandbox mode: it will only send to the address the account was registered with until a domain is verified. Use SMTP_USER/SMTP_PASS instead if you do not have a domain.'
        : body.slice(0, 200);
      return { ok: false, error: `${res.status} ${detail}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'send failed' };
  }
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
