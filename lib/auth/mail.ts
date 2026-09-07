/**
 * Sending the two emails this product sends.
 *
 * Resend over its HTTP API, called with `fetch` — no SDK, because the whole integration
 * is one POST and a dependency here would be more code than the thing it wraps. Swapping
 * provider means changing `deliver()` and nothing else.
 *
 * Both messages are plain text with the link on its own line. A link inside an HTML
 * button is the shape phishing takes, and a verification email that looks like phishing
 * gets ignored — which turns into "I never got the email".
 */

import 'server-only';

export interface MailResult {
  ok: boolean;
  /** Set when the mail could not be sent, for the caller to log rather than display. */
  error?: string;
  /** True when no provider is configured and the link was logged instead. */
  loggedOnly?: boolean;
}

function config() {
  return {
    apiKey: process.env.RESEND_API_KEY?.trim() || '',
    from: process.env.EMAIL_FROM?.trim() || '',
  };
}

export function isMailConfigured(): boolean {
  const { apiKey, from } = config();
  return Boolean(apiKey && from);
}

async function deliver(to: string, subject: string, text: string): Promise<MailResult> {
  const { apiKey, from } = config();

  // With no provider the link goes to the server log. In development that is the whole
  // flow working without an account anywhere; in production the caller checks
  // isMailConfigured() first and refuses signup rather than stranding someone.
  if (!apiKey || !from) {
    console.warn(`[mail] no provider configured. To: ${to}\nSubject: ${subject}\n${text}`);
    return { ok: true, loggedOnly: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `${res.status} ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'send failed' };
  }
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
