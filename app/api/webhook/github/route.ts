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
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';

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

  if (req.headers.get('x-github-event') === 'ping') {
    return Response.json({ ok: true, pong: true });
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
