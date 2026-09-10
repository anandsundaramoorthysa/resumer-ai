/**
 * "Do I have a password on this account?", answered somewhere the user can find it.
 *
 * The gap this closes is a dead end with no error message in it. /set-password is only
 * ever reached one way: `oauthSignInAction` sends every provider sign-in through it, and
 * the page waves through anyone who already has a password. That is deliberate — see
 * app/set-password/page.tsx for why it is a stop on the way in rather than a gate on
 * every route — but it means the only door into the step is a fresh OAuth sign-in, and
 * the step offers "Not now" in as many words. Someone who takes that, or who closes the
 * tab, has to sign out and sign in with their provider again to be asked a second time.
 * Nothing anywhere in the app tells them so, and nothing tells them what state they are
 * in either: an account with no password looks exactly like an account with one until
 * the day they try to sign in with an address instead of a provider button, and get told
 * the same thing a wrong password gets told.
 *
 * So this states the fact rather than nagging about it. Having no password is a
 * legitimate way to use the app — the provider is a perfectly good credential, and for
 * an account that only ever signs in with Google, adding a password adds a second thing
 * to steal. What it is not is something that should be a surprise.
 *
 * It reads its own session and row instead of taking props, for the reason
 * components/app-header.tsx gives for doing the same: a settings page that had to thread
 * the state through could disagree with the database, and this is a statement about the
 * database. It also keeps the edit to the settings page down to an import and a tag,
 * which is the whole of this component's footprint over there.
 */

import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, isDatabaseConfigured } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { needsInitialPassword } from '@/lib/auth/initial-password';

export async function PasswordStatusCard() {
  if (!isDatabaseConfigured) return null;

  const session = await auth();
  if (!session?.user?.id) return null;

  const [account] = await db
    .select({ passwordHash: users.passwordHash, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  if (!account) return null;

  /**
   * `needsInitialPassword` decides whether the link is offered, rather than a
   * `passwordHash === null` test written out here.
   *
   * The two disagree for an unverified row, and that disagreement is the whole reason to
   * use the shared predicate: such a row has no password AND may not set one on this
   * path, so linking it to /set-password would send the user to a page that redirects
   * them straight back to `/` with no explanation. Reusing the predicate that guards the
   * page means this card cannot offer a door the page will not open. The state is
   * unreachable in practice — every OAuth sign-in stamps `emailVerified` — which is
   * exactly the kind of branch that would never have been caught by hand.
   *
   * Nothing here reads or renders the hash itself; `hasPassword` is a boolean taken from
   * whether the column is set, and the value never leaves the server.
   */
  const canSetOne = needsInitialPassword(account);
  const hasPassword = Boolean(account.passwordHash);

  return (
    <section className="mt-10 rounded-xl border border-line bg-surface p-5">
      <h2 className="font-display text-lg">How you sign in</h2>

      {hasPassword ? (
        <p className="mt-2 max-w-prose text-sm text-muted">
          This account has a password, so you can sign in with your email address as well
          as with any provider you have linked. To change it, use{' '}
          <Link href="/forgot-password" className="font-semibold text-ink underline">
            Forgot your password?
          </Link>{' '}
          — changing a password goes through your inbox, because that is the one thing a
          session cannot prove on its own.
        </p>
      ) : canSetOne ? (
        <>
          <p className="mt-2 max-w-prose text-sm text-muted">
            This account has <strong className="text-ink">no password</strong>. You signed
            up with Google or GitHub, which never sets one, so signing in with your email
            address does not work — and it fails in exactly the way a wrong password
            fails, without saying why. If you lose access to that provider account, you
            lose access to this one.
          </p>
          <Link
            href="/set-password"
            className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-brand-dark"
          >
            Create a password
          </Link>
        </>
      ) : (
        <p className="mt-2 max-w-prose text-sm text-muted">
          This account has no password, and its email address has not been confirmed yet.
          Confirm it from the link we sent you, and you will be able to set one.
        </p>
      )}
    </section>
  );
}
