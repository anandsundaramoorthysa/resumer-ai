/**
 * Transactional email bodies: a plain-text part and a minimal HTML part.
 *
 * The HTML is deliberately plain: inline styles only, no remote images, no tracking, links
 * written out in full as visible text (a bare URL is also in the text part), colours that
 * hold up when a client forces dark mode (no hard-coded white card on a coloured page: the
 * body sets neither background nor text colour, so the client's own scheme applies).
 */

import { APP_NAME, GRIEVANCE } from '@/lib/legal/config';

export interface Email {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(heading: string, paragraphs: string[], link?: { url: string; label: string }): Pick<Email, 'html' | 'text'> {
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>',
    '<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">',
    '<div style="max-width:560px;margin:0 auto;">',
    `<p style="margin:0 0 16px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;">${esc(APP_NAME)}</p>`,
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;">${esc(heading)}</h1>`,
    ...paragraphs.map((p) => `<p style="margin:0 0 16px;">${esc(p)}</p>`),
    link
      ? `<p style="margin:0 0 16px;"><a href="${esc(link.url)}" style="text-decoration:underline;font-weight:bold;">${esc(link.label)}</a><br><span style="font-size:13px;word-break:break-all;">${esc(link.url)}</span></p>`
      : '',
    `<p style="margin:24px 0 0;font-size:13px;">Questions: write to ${esc(GRIEVANCE.email)}.</p>`,
    '</div></body></html>',
  ].join('');
  const text = [heading, '', ...paragraphs.flatMap((p) => [p, '']), ...(link ? [link.url, ''] : []), `Questions: ${GRIEVANCE.email}`].join('\n');
  return { html, text };
}

export function approvalGrantedEmail(signInUrl: string): Email {
  return {
    subject: `Your ${APP_NAME} account is ready`,
    ...render('Your account is approved', ['You can sign in and start building your profile.'], { url: signInUrl, label: 'Sign in' }),
  };
}

export function approvalDeniedEmail(accountUrl: string): Email {
  return {
    subject: `About your ${APP_NAME} sign-up`,
    ...render(
      'Your sign-up was not approved',
      [
        'Access is limited right now, and your account was not approved.',
        'Nothing you entered is used for anything while the account waits. You can delete the account and everything in it from your account page; accounts that are not approved are also deleted automatically after 30 days.',
      ],
      { url: accountUrl, label: 'Open your account page' },
    ),
  };
}

export function inviteRedeemedPendingEmail(): Email {
  return {
    subject: `We have your ${APP_NAME} invite`,
    ...render('You are on the list', [
      "Your invite code was valid, but we have reached today's limit for automatic approvals.",
      'The owner will approve your account by hand, and you will get another email when that happens. Your code was not used up.',
    ]),
  };
}
