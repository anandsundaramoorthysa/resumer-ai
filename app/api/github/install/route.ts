/**
 * Where GitHub sends the user after they install the app.
 *
 * The redirect carries `installation_id` as a query parameter, which means the browser
 * can put anything there — so it is not trusted. Looking it up with the app's JWT proves
 * only that it exists; this route used to stop there, and anyone signed in could claim
 * any installation by editing the URL, reading its private repositories and taking it
 * from its owner. Now the installation must be on the GitHub account this user signed in
 * with, and a row already recorded for someone else is never moved.
 *
 * `setup_action` is `install` for a new installation and `update` when someone changes
 * which repositories are selected. Both are recorded the same way; the second is how a
 * user adds their portfolio repo after installing on the wrong one.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { getInstallation, installationOwnedBy, organizationIdsFor } from '@/lib/github/app';
import { githubAccountIdsFor, recordInstallation } from '@/lib/server/repo-access';
import { getGithubToken } from '@/lib/server/github-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function backToSettings(message: string, ok: boolean): Response {
  const params = new URLSearchParams({ [ok ? 'installed' : 'installError']: message });
  return Response.redirect(
    new URL(
      `/settings/portfolio?${params}`,
      process.env.AUTH_URL || 'http://localhost:3000',
    ),
    303,
  );
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.redirect(
      new URL('/sign-in', process.env.AUTH_URL || 'http://localhost:3000'),
      303,
    );
  }

  const raw = req.nextUrl.searchParams.get('installation_id');
  const installationId = Number(raw);
  if (!raw || !Number.isInteger(installationId) || installationId <= 0) {
    return backToSettings('GitHub did not say which installation that was.', false);
  }

  // The one call that turns a URL parameter into a fact.
  const installation = await getInstallation(installationId);
  if (!installation) {
    return backToSettings(
      'That installation could not be confirmed with GitHub. Try installing again.',
      false,
    );
  }

  // For an organisation, membership is the claim — and it can only be read with the
  // user's own token, so it is fetched only in that case.
  const token = installation.targetType === 'Organization' ? await getGithubToken(session.user.id) : null;
  const organizationIds = token ? await organizationIdsFor(token) : [];

  if (!installationOwnedBy(installation, await githubAccountIdsFor(session.user.id), organizationIds)) {
    return backToSettings(
      installation.targetType === 'User'
        ? `The app was installed on @${installation.accountLogin}, which is not a GitHub account you have signed in with here. Sign in with that GitHub account once, then install again.`
        : `Could not confirm that you belong to @${installation.accountLogin}. Sign in with GitHub again to re-grant access — the check needs permission to read your organisation memberships — then install once more.`,
      false,
    );
  }

  const recorded = await recordInstallation({
    id: installation.id,
    userId: session.user.id,
    accountLogin: installation.accountLogin,
    targetType: installation.targetType,
    repositorySelection: installation.repositorySelection,
  });
  if (!recorded) {
    return backToSettings('That installation is already connected to another Resumer AI account.', false);
  }

  return backToSettings(installation.accountLogin, true);
}
