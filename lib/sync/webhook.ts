/**
 * What a GitHub webhook delivery means for the portfolio sync — pure, so it is tested
 * against fixture payloads without a database or a request.
 *
 * The route used to clear the cached commit SHA for ANY event that carried a repository:
 * a star, an issue comment, a push to a feature branch. Each of those made the next draft
 * pay for a full re-parse of a portfolio that had not changed. Only a push to the default
 * branch can change what the sync reads, so only that invalidates.
 *
 * `users.portfolio_repo` stores the name ("owner/name") and no repository id, so a rename
 * left it pointing at a name that no longer exists: every later push arrived as
 * `owner/new-name`, matched nothing, and the cache was never cleared again. A `repository`
 * event with action `renamed` (or `transferred`) names the old name in `changes`, which is
 * the only place the old name can be recovered from, so that event re-points the stored
 * name instead of being ignored.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type WebhookAction =
  | { kind: 'ignore'; reason: string }
  /** Clear the cached SHA for whoever tracks this repository (matched case-insensitively). */
  | { kind: 'invalidate'; fullName: string }
  /** The tracked repository was renamed or moved: follow it, and clear the cache. */
  | { kind: 'rename'; from: string; to: string };

interface Payload {
  ref?: string;
  action?: string;
  deleted?: boolean;
  repository?: {
    id?: number;
    name?: string;
    full_name?: string;
    default_branch?: string;
    owner?: { login?: string };
  };
  changes?: {
    repository?: { name?: { from?: string } };
    owner?: { from?: { user?: { login?: string }; organization?: { login?: string } } };
  };
}

export function decideWebhook(event: string | null, payload: Payload): WebhookAction {
  const repo = payload.repository;
  const fullName = repo?.full_name;
  if (!fullName) return { kind: 'ignore', reason: 'no repository' };

  if (event === 'push') {
    // A branch deletion is a push too, and has nothing to sync.
    if (payload.deleted) return { kind: 'ignore', reason: 'branch deleted' };
    const branch = repo?.default_branch;
    if (!branch || payload.ref !== `refs/heads/${branch}`) {
      return { kind: 'ignore', reason: 'not the default branch' };
    }
    return { kind: 'invalidate', fullName };
  }

  if (event === 'repository' && (payload.action === 'renamed' || payload.action === 'transferred')) {
    const oldName = payload.changes?.repository?.name?.from ?? repo?.name;
    const oldOwner =
      payload.changes?.owner?.from?.user?.login ??
      payload.changes?.owner?.from?.organization?.login ??
      repo?.owner?.login;
    if (!oldName || !oldOwner) return { kind: 'ignore', reason: 'rename without a previous name' };
    const from = `${oldOwner}/${oldName}`;
    if (from.toLowerCase() === fullName.toLowerCase()) {
      return { kind: 'ignore', reason: 'rename changed nothing' };
    }
    return { kind: 'rename', from, to: fullName };
  }

  return { kind: 'ignore', reason: `event ${event ?? 'unknown'} does not change the portfolio` };
}
