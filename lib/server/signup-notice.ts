/**
 * Telling the owner someone signed up — lib/server/approval.ts has the whole design.
 *
 * Its own module because the adapter in auth.ts calls it, and approval.ts imports auth.
 */

import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { ownerEmails, ownerUserIds } from '@/lib/ai/daily-budget';
import { appUrl, sendOperatorEmail } from '@/lib/auth/mail';

/** More than this many waiting, and individual emails stop: the review page lists them. */
export const NOTIFY_CEILING = 10;

/**
 * Tells the owner someone signed up. Never throws — a sign-up must not fail because the
 * owner could not be told about it; the review page lists every pending account anyway.
 *
 * A flood of sign-ups (one bot, many addresses) would otherwise become a flood of mail, so
 * past NOTIFY_CEILING pending accounts the individual emails stop.
 */
export async function notifyOwnerOfSignup(user: { id: string; email?: string | null; name?: string | null }, method: string): Promise<void> {
  try {
    if ((await ownerUserIds()).includes(user.id)) return;
    const to = [...ownerEmails()][0] ?? process.env.ALERT_EMAIL?.trim();
    if (!to) return;
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.approval, 'pending'));
    if (n > NOTIFY_CEILING) return;

    const sent = await sendOperatorEmail(
      to,
      `Resumer AI: ${user.email ?? 'someone'} signed up and is waiting for you`,
      [
        'Someone created an account and is waiting for your decision.',
        '',
        `  Name:    ${user.name?.trim() || '(not given)'}`,
        `  Email:   ${user.email ?? '(none)'}`,
        `  Method:  ${method}`,
        '',
        'Review it — you will need to be signed in as the owner:',
        appUrl('/admin/approvals'),
        '',
        'Until you approve, they can sign in but cannot use anything. Nothing happens if you ignore this.',
      ].join('\n'),
    );
    if (!sent.ok) console.error('[approval] could not tell the owner about a sign-up:', sent.error);
  } catch (err) {
    console.error('[approval] owner notification failed:', err);
  }
}
