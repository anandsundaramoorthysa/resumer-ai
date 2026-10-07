import { notFound } from 'next/navigation';
import { AppHeader } from '@/components/app-header';
import { getSession } from '@/lib/server/session';
import { isOwnerSession } from '@/lib/server/approval';
import { FLAG_DEFAULTS, FLAG_KEYS, getFlag, type FlagKey } from '@/lib/server/flags';
import { setFlagAction } from './actions';

export const metadata = { title: 'Switches' };
export const dynamic = 'force-dynamic';

const HELP: Record<FlagKey, string> = {
  radar_enabled: 'Job Radar (SerpApi spend). Off stops new runs.',
  ai_enabled: 'All AI generation. Off stops drafts and imports that call a model.',
  signups_enabled: 'New account sign-ups.',
  maintenance_message: 'Banner text shown to everyone. Empty hides it.',
};

/** Owner-only kill switches. Anyone else gets a plain 404, like /admin/approvals. */
export default async function FlagsPage() {
  const session = await getSession();
  if (!(await isOwnerSession(session))) notFound();

  const current = await Promise.all(FLAG_KEYS.map(async (k) => [k, await getFlag(k, FLAG_DEFAULTS[k])] as const));

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader width="6xl" session={session} />
      <main id="main" tabIndex={-1} className="mx-auto max-w-4xl px-5 py-8 outline-none">
        <p className="eyebrow">&sect; Admin</p>
        <h1 className="mt-1 font-display text-4xl tracking-tight">Switches</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Changes apply within about 15 seconds on each server instance. An environment variable
          <code> FLAG_&lt;NAME&gt;</code> overrides the value here. Every change is written to the audit log.
        </p>
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {current.map(([key, value]) => (
            <li key={key} className="py-4">
              <p className="font-semibold">{key}</p>
              <p className="text-xs text-muted">{HELP[key]}</p>
              <form action={setFlagAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="key" value={key} />
                {key === 'maintenance_message' ? (
                  <input name="value" defaultValue={value} maxLength={500} className="input min-w-64 flex-1" aria-label={key} />
                ) : (
                  <select name="value" defaultValue={value} className="input" aria-label={key}>
                    <option value="true">on</option>
                    <option value="false">off</option>
                  </select>
                )}
                <button type="submit" className="btn btn-primary">Save</button>
              </form>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
