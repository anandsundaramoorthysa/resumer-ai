/**
 * GitHub push webhook — REQ-2.5.
 *
 * Optional. Clears the cached commit SHA so the next draft re-parses immediately rather
 * than waiting for the pre-draft check to notice on its own. The SHA gate already keeps
 * things correct without this; the webhook just removes the lag between pushing a
 * portfolio update and the app knowing about it.
 *
 * Configure at: repo Settings -> Webhooks -> payload URL
 *   https://<your-host>/api/webhook/github   (content type: application/json)
 * and set GITHUB_WEBHOOK_SECRET to the same secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { forgetInstallation } from '@/lib/github/app';
import { markInstallationRemoved } from '@/lib/server/repo-access';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: 'Webhook not configured.' }, { status: 501 });
  }

  const raw = await req.text();
  const signature = req.headers.get('x-hub-signature-256');

  if (!signature || !verifySignature(raw, signature, secret)) {
    return Response.json({ error: 'Bad signature.' }, { status: 401 });
  }

  const event = req.headers.get('x-github-event');

  if (event === 'ping') {
    return Response.json({ ok: true, pong: true });
  }

  /**
   * Installation lifecycle.
   *
   * Without this the app keeps a row saying it can read a repository long after the user
   * revoked that. Nothing breaks visibly — token minting just starts failing — but the
   * settings page would go on claiming access that no longer exists, which is the kind
   * of quiet lie that makes a permissions screen worthless.
   */
  if (event === 'installation' || event === 'installation_repositories') {
    const body = JSON.parse(raw) as {
      action?: string;
      installation?: {
        id?: number;
        account?: { login?: string; type?: string };
        repository_selection?: string;
      };
    };

    const id = body.installation?.id;
    if (!id) return Response.json({ ok: true, ignored: 'no installation id' });

    if (body.action === 'deleted' || body.action === 'suspend') {
      await markInstallationRemoved(id);
      forgetInstallation(id);
      return Response.json({ ok: true, installation: id, removed: true });
    }

    // A repository added or removed changes what the same installation can see, so the
    // cached token is dropped: it carries the old repository list.
    forgetInstallation(id);

    if (body.action === 'unsuspend' || event === 'installation_repositories') {
      // The row is only updated, never created, from a webhook: an installation reaches
      // us first through the redirect, where a signed-in user proves it is theirs. A
      // webhook has no user attached, so creating a row here would leave an installation
      // owned by nobody — or worse, guessable into someone else's account.
      await db.execute(
        sql`update github_installation
            set repository_selection = ${body.installation?.repository_selection ?? 'selected'},
                removed_at = null
            where id = ${id}`,
      );
    }

    return Response.json({ ok: true, installation: id });
  }

  const payload = JSON.parse(raw) as {
    repository?: { full_name?: string };
  };
  const repo = payload.repository?.full_name;
  if (!repo) return Response.json({ ok: true, ignored: 'no repository' });

  // Clearing the cached SHA is all that's needed — the next draft's gate sees a
  // mismatch and re-parses. No work is done on the webhook's thread.
  const updated = await db
    .update(users)
    .set({ lastSyncedSha: null })
    .where(eq(users.portfolioRepo, repo))
    .returning({ id: users.id });

  return Response.json({ ok: true, invalidated: updated.length });
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
