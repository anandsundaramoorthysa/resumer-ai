import { notFound } from 'next/navigation';
import { auth } from '@/auth';
import { AppHeader } from '@/components/app-header';
import { isOwnerSession } from '@/lib/server/approval';
import { listInvites } from '@/lib/legal/invites';
import { autoApproveDailyQuota, signupMode } from '@/lib/legal/config';
import { formatDateTime } from '@/lib/format';
import { CreateInviteForm, DisableButton } from './invite-form';

export const metadata = { title: 'Invite codes' };
export const dynamic = 'force-dynamic';

function inviteState(i: { disabled: boolean; expiresAt: Date | null; uses: number; maxUses: number }): string {
  if (i.disabled) return 'disabled';
  if (i.expiresAt !== null && i.expiresAt.getTime() <= Date.now()) return 'expired';
  return i.uses >= i.maxUses ? 'used up' : 'active';
}

/** Owner-only, like /admin/approvals: anyone else gets a plain 404. */
export default async function InvitesPage() {
  const session = await auth();
  if (!(await isOwnerSession(session))) notFound();
  const invites = await listInvites();

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader width="6xl" />
      <main id="main" tabIndex={-1} className="mx-auto max-w-4xl px-5 py-8 outline-none">
        <p className="eyebrow">§ Admin</p>
        <h1 className="mt-1 font-display text-4xl tracking-tight">Invite codes</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Signup mode: <span className="font-mono">{signupMode()}</span>. A valid code approves a new
          account automatically, up to {autoApproveDailyQuota()} accounts per India-time day; past that,
          accounts wait for you on the approvals page and no code is used up. Codes are stored hashed,
          so the code is shown once, when you create it.
        </p>

        <section className="mt-8 border-t border-line pt-4" aria-labelledby="new-heading">
          <h2 id="new-heading" className="font-display text-xl">New code</h2>
          <CreateInviteForm />
        </section>

        <section className="mt-10 border-t border-line pt-4" aria-labelledby="list-heading">
          <h2 id="list-heading" className="font-display text-xl">Codes ({invites.length})</h2>
          {invites.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No codes yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {invites.map((i) => {
                const state = inviteState(i);
                return (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="font-semibold [overflow-wrap:anywhere]">{i.label || '(no label)'}</span>
                      <span className="block text-xs text-muted">
                        {i.uses} of {i.maxUses} used · {state} · created {formatDateTime(i.createdAt)}
                        {i.expiresAt ? ` · expires ${formatDateTime(i.expiresAt)}` : ''}
                      </span>
                    </span>
                    <DisableButton id={i.id} disabled={i.disabled} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
