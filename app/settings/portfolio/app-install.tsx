/**
 * The GitHub App install panel.
 *
 * This is the part of the settings page that explains a trade the user is being asked to
 * make, so it says what changes rather than only offering a button. Someone who already
 * granted `repo` has no reason to install anything unless they are told that the old
 * grant was read *and write* to every repository they own and the new one is read on the
 * ones they pick.
 *
 * A server component: it holds no state, and the install itself is a plain link to
 * GitHub rather than anything this app performs.
 */

import { installUrl, isGitHubAppConfigured } from '@/lib/github/app';
import { installationsFor } from '@/lib/server/repo-access';
import { listInstallationRepos } from '@/lib/github/app';

export async function AppInstallPanel({
  userId,
  currentRepo,
  notice,
}: {
  userId: string;
  currentRepo: string | null;
  notice?: { kind: 'installed' | 'error'; message: string };
}) {
  if (!isGitHubAppConfigured()) return null;

  const installations = await installationsFor(userId);
  const url = installUrl();

  // Only asked for when there is an installation to ask about, and it is one call.
  const reposByInstallation = await Promise.all(
    installations.map(async (i) => ({
      installation: i,
      repos: await listInstallationRepos(i.id),
    })),
  );

  const allRepos = reposByInstallation.flatMap((r) => r.repos);
  const covered =
    currentRepo !== null &&
    allRepos.some((r) => r.toLowerCase() === currentRepo.toLowerCase());

  /*
   * No top margin of its own.
   *
   * This is the first thing in the left-hand column of the two-column layout on the
   * settings page, and the `mt-7` it used to carry pushed that column 28px below the
   * explanation card beside it — two cards at the top of the same row, starting at
   * different heights. The grid that owns both columns owns the space above them.
   */
  return (
    <section className="border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-lg">Repository access</h2>
        {installations.length > 0 ? (
          <span className="font-mono text-xs text-success">
            installed on {installations.length} account
            {installations.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {notice ? (
        <p
          className={`mt-3 px-3 py-2 text-sm ${
            notice.kind === 'installed'
              ? 'bg-success-tint text-success'
              : 'bg-danger-tint text-danger'
          }`}
          role="status"
        >
          {notice.kind === 'installed'
            ? `Installed on ${notice.message}.`
            : notice.message}
        </p>
      ) : null}

      {installations.length === 0 ? (
        <>
          <p className="mt-2 max-w-prose text-sm text-muted">
            Signing in with GitHub currently grants <strong>read and write access to
            every repository you own</strong> — that is the only OAuth scope that can
            reach a private repo, and it is far more than this needs. Installing the app
            instead gives <strong>read-only access to the repositories you pick</strong>,
            and the access is granted per request rather than stored here at all.
          </p>
          <p className="mt-2 max-w-prose text-sm text-muted">
            Pick just your portfolio repository. Nothing else is ever read.
          </p>
        </>
      ) : (
        <>
          <ul className="mt-3 space-y-2">
            {reposByInstallation.map(({ installation, repos }) => (
              <li key={installation.id} className="border border-line px-3.5 py-2.5">
                <p className="text-sm font-semibold">
                  {installation.accountLogin}
                  <span className="ml-2 font-mono text-xs font-normal text-muted">
                    {installation.targetType.toLowerCase()}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  {installation.repositorySelection === 'all'
                    ? 'All repositories'
                    : repos.length > 0
                      ? repos.join(', ')
                      : 'No repositories selected'}
                </p>
              </li>
            ))}
          </ul>

          {currentRepo && !covered ? (
            <p className="mt-3 bg-warning-tint/50 px-3 py-2 text-sm text-warning">
              The app is installed, but <span className="font-mono">{currentRepo}</span> is
              not one of the repositories it can read. Use the link below to add it —
              otherwise sync falls back to the older, broader access.
            </p>
          ) : null}

          {currentRepo && covered ? (
            <p className="mt-3 text-sm text-success">
              Read access to <span className="font-mono">{currentRepo}</span> is granted
              through the app. Nothing long-lived is stored — each sync mints a token that
              expires within the hour.
            </p>
          ) : null}
        </>
      )}

      {url ? (
        <a
          href={url}
          className="btn btn-primary mt-4 inline-flex text-sm"
        >
          {installations.length === 0 ? 'Install on GitHub' : 'Change which repositories'}
        </a>
      ) : (
        <p className="mt-4 text-xs text-muted">
          Set <span className="font-mono">GITHUB_APP_SLUG</span> to show the install link.
        </p>
      )}
    </section>
  );
}
