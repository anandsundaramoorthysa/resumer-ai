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

import { NextRequest } from 'next/server';
import { decideWebhook, verifySignature } from '@/lib/sync/webhook';
import { sql } from 'drizzle-orm';
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
    const body = parseJsonBody<{
      action?: string;
      installation?: {
        id?: number;
        account?: { login?: string; type?: string };
        repository_selection?: string;
      };
    }>(raw);
    if (!body) return Response.json({ error: 'Body must be JSON.' }, { status: 400 });

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

    const reactivates =
      body.action === 'unsuspend' || (event === 'installation_repositories' && body.action === 'added');
    if (body.action === 'unsuspend' || event === 'installation_repositories') {
      // The row is only updated, never created, from a webhook: an installation reaches
      // us first through the redirect, where a signed-in user proves it is theirs. A
      // webhook has no user attached, so creating a row here would leave an installation
      // owned by nobody — or worse, guessable into someone else's account.
      await db.execute(
        sql`update github_installation
            set repository_selection = ${body.installation?.repository_selection ?? 'selected'},
                removed_at = case when ${reactivates} then null else removed_at end
            where id = ${id}`,
      );
    }

    return Response.json({ ok: true, installation: id });
  }

  const payload = parseJsonBody<Parameters<typeof decideWebhook>[1]>(raw);
  if (!payload) return Response.json({ error: 'Body must be JSON.' }, { status: 400 });

  // Only a push to the default branch can change what the sync reads (lib/sync/webhook.ts).
  const action = decideWebhook(event, payload);
  if (action.kind === 'ignore') return Response.json({ ok: true, ignored: action.reason });

  if (action.kind === 'rename') {
    // Follow the repository to its new name, so later pushes match again.
    const moved = await db
      .update(users)
      .set({ portfolioRepo: action.to, lastSyncedSha: null })
      .where(sql`lower(${users.portfolioRepo}) = lower(${action.from})`)
      .returning({ id: users.id });
    return Response.json({ ok: true, renamed: moved.length });
  }

  // Clearing the cached SHA is all that's needed — the next draft's gate sees a
  // mismatch and re-parses. No work is done on the webhook's thread.
  const updated = await db
    .update(users)
    .set({ lastSyncedSha: null })
    // Case-insensitively: a user who typed "Owner/Repo" never had their cache cleared.
    .where(sql`lower(${users.portfolioRepo}) = lower(${action.fullName})`)
    .returning({ id: users.id });

  return Response.json({ ok: true, invalidated: updated.length });
}

/** Null for anything that is not a JSON object (e.g. a form-encoded `payload=` body). */
function parseJsonBody<T>(raw: string): T | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}
