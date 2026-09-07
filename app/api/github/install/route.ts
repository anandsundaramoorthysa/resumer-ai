/**
 * Where GitHub sends the user after they install the app.
 *
 * The redirect carries `installation_id` as a query parameter, which means the browser
 * can put anything there — so it is not trusted. It is looked up against GitHub with the
 * app's own JWT, and only what GitHub says about it is stored. Without that check, one
 * user could claim another's installation by editing a URL, and inherit read access to
 * their repositories.
 *
 * `setup_action` is `install` for a new installation and `update` when someone changes
 * which repositories are selected. Both are recorded the same way; the second is how a
 * user adds their portfolio repo after installing on the wrong one.
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { getInstallation } from '@/lib/github/app';
import { recordInstallation } from '@/lib/server/repo-access';

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

  await recordInstallation({
    id: installation.id,
    userId: session.user.id,
    accountLogin: installation.accountLogin,
    targetType: installation.targetType,
    repositorySelection: installation.repositorySelection,
  });

  return backToSettings(installation.accountLogin, true);
}
