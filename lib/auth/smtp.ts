/**
 * SMTP delivery, configured for Gmail out of the box.
 *
 * This exists because the alternative needs a domain. Resend and every other transactional
 * provider will only send from `onboarding@resend.dev`-style sandbox addresses until you
 * verify a domain you own, and a sandbox sender can only mail the account holder — which
 * is fine while you are the only user and useless the moment someone else signs up.
 * A Gmail app password needs no domain and delivers to anyone.
 *
 * What it costs: Gmail caps a consumer account at roughly 500 recipients a day (2,000 on
 * Workspace), and mail sent this way is authenticated as a person rather than as a
 * service, so it has none of the deliverability engineering a real sending domain gets.
 * That is the right trade for a personal product and the wrong one for a business, which
 * is why `lib/auth/mail.ts` prefers a real provider whenever one is configured.
 *
 * Google retired plain-password SMTP in 2022. The password here must be a 16-character
 * app password from an account with 2-Step Verification enabled.
 */

import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * Reads the SMTP settings, filling in Gmail's where they were not given.
 *
 * Only `SMTP_USER` and `SMTP_PASS` are required. Anyone using Gmail should not have to
 * look up a hostname and a port number to send their own mail, and anyone using something
 * else can override all four.
 */
export function smtpConfig(): SmtpConfig | null {
  const user = process.env.SMTP_USER?.trim() || '';
  // Google displays an app password as four groups of four for readability. The spaces
  // are not part of it, and a pasted password that still contains them fails to
  // authenticate with an error that says nothing about spaces.
  const pass = (process.env.SMTP_PASS ?? '').replace(/\s+/g, '');
  if (!user || !pass) return null;

  const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT ?? '') || 465;

  return {
    host,
    port,
    // 465 is implicit TLS; 587 upgrades with STARTTLS after connecting. Getting this
    // wrong is the usual cause of a connection that opens and then hangs.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    user,
    pass,
    // Gmail rewrites the From header to the authenticated account regardless of what is
    // asked for, so defaulting to the account is honest rather than limiting.
    from: process.env.EMAIL_FROM?.trim() || user,
  };
}

let cached: { key: string; transport: Transporter } | null = null;

/**
 * One transporter per configuration, reused across requests.
 *
 * A warm serverless instance handles several requests, and building a transport per
 * message means a fresh TLS handshake with Gmail every time — which is both slow and the
 * kind of connection churn that gets an account rate-limited.
 */
export function smtpTransport(config: SmtpConfig): Transporter {
  const key = `${config.host}:${config.port}:${config.user}`;
  if (cached?.key === key) return cached.transport;

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },

    // Nothing here should ever read a file or fetch a URL while building a message.
    // Both are off explicitly: nodemailer's advisory GHSA-p6gq-j5cr-w38f is about a
    // message option that reaches the filesystem and the network, and the defence that
    // does not depend on remembering is for the transport to refuse both outright.
    disableFileAccess: true,
    disableUrlAccess: true,

    // A hung connection must not eat the whole function budget. Netlify gives a
    // synchronous function ten seconds; an SMTP connect with no timeout will happily
    // spend all of it and return nothing.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 12000,
  });

  cached = { key, transport };
  return transport;
}

export interface SmtpSendResult {
  ok: boolean;
  error?: string;
}

export async function sendViaSmtp(
  config: SmtpConfig,
  to: string,
  subject: string,
  text: string,
): Promise<SmtpSendResult> {
  try {
    await smtpTransport(config).sendMail({ from: config.from, to, subject, text });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeSmtpError(err) };
  }
}

/**
 * Turns an SMTP failure into something worth reading in a log.
 *
 * Gmail's authentication failure is a wall of text ending in a support URL, and the one
 * fact that matters — that this needs an app password rather than the account password —
 * is not in it. These are the three failures that actually happen during setup.
 */
export function describeSmtpError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? '';

  if (/invalid login|username and password not accepted|BadCredentials/i.test(message)) {
    return `SMTP rejected the credentials. Gmail needs a 16-character app password from an account with 2-Step Verification on — the account password will not work. (${message.slice(0, 120)})`;
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || /timeout/i.test(message)) {
    return `SMTP connection timed out. Check SMTP_PORT: 465 needs SMTP_SECURE=true, 587 needs false. (${code || message.slice(0, 120)})`;
  }
  if (/Daily user sending (limit|quota) exceeded/i.test(message)) {
    return 'Gmail daily sending limit reached — about 500 messages on a consumer account.';
  }
  return message.slice(0, 200);
}

/** Opens a connection and authenticates without sending anything. Used by the setup check. */
export async function verifySmtp(config: SmtpConfig): Promise<SmtpSendResult> {
  try {
    await smtpTransport(config).verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeSmtpError(err) };
  }
}
